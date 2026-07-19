const STORAGE_API_VERSION = '2023-11-03';
const MAX_LOCK_RECORD_BYTES = 16 * 1024;

export class BlobLeaseStoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function normalizeContainerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Blob lease store requires a valid container URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === '/'
  ) {
    throw new TypeError('Blob lease store requires an HTTPS container URL without credentials or query data.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function lockBlobUrl(containerUrl, key) {
  const segments = String(key || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  if (!segments.length) {
    throw new TypeError('Blob lease store requires a lock key.');
  }
  return `${containerUrl}/${segments.join('/')}`;
}

function leaseUrl(blobUrl) {
  const url = new URL(blobUrl);
  url.searchParams.set('comp', 'lease');
  return url.toString();
}

function responseErrorCode(response) {
  return response.headers.get('x-ms-error-code') || '';
}

function isLeaseConflict(response) {
  return response.status === 409 || response.status === 412;
}

function accessTokenValue(value) {
  const token = typeof value === 'string' ? value : value?.token;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new BlobLeaseStoreError('storage_authentication_unavailable');
  }
  return token.trim();
}

export function createBlobLeaseStore({
  containerUrl,
  getAccessToken,
  fetch: fetchRequest = globalThis.fetch,
  now = Date.now,
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  const normalizedContainerUrl = normalizeContainerUrl(containerUrl);
  if (
    typeof getAccessToken !== 'function' ||
    typeof fetchRequest !== 'function' ||
    typeof now !== 'function' ||
    typeof randomUUID !== 'function'
  ) {
    throw new TypeError('Blob lease store requires token, fetch, clock, and UUID functions.');
  }

  async function request(url, { method, headers = {}, body } = {}) {
    let token;
    try {
      token = accessTokenValue(await getAccessToken());
    } catch (error) {
      if (error instanceof BlobLeaseStoreError) {
        throw error;
      }
      throw new BlobLeaseStoreError('storage_authentication_unavailable');
    }
    try {
      return await fetchRequest(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'x-ms-date': new Date(now()).toUTCString(),
          'x-ms-version': STORAGE_API_VERSION,
          'x-ms-client-request-id': randomUUID(),
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new BlobLeaseStoreError('storage_request_failed');
    }
  }

  async function ensureLockBlob(blobUrl) {
    const existing = await request(blobUrl, { method: 'HEAD' });
    if (existing.status === 200) {
      return;
    }
    if (existing.status !== 404) {
      throw new BlobLeaseStoreError('storage_request_rejected');
    }
    const response = await request(blobUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-None-Match': '*',
        'x-ms-blob-type': 'BlockBlob',
      },
      body: '{}',
    });
    const errorCode = responseErrorCode(response);
    if (
      response.status === 201 ||
      (response.status === 412 && errorCode === 'ConditionNotMet') ||
      (response.status === 409 && errorCode === 'BlobAlreadyExists')
    ) {
      return;
    }
    throw new BlobLeaseStoreError(
      errorCode ? 'storage_request_rejected' : 'storage_request_failed',
    );
  }

  async function readRecord(blobUrl) {
    const response = await request(blobUrl, { method: 'GET' });
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200) {
      throw new BlobLeaseStoreError('storage_request_rejected');
    }
    const serialized = await response.text();
    if (serialized.length > MAX_LOCK_RECORD_BYTES) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(serialized);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async function writeRecord(blobUrl, leaseId, record) {
    const serialized = JSON.stringify(record);
    if (serialized.length > MAX_LOCK_RECORD_BYTES) {
      throw new BlobLeaseStoreError('storage_record_too_large');
    }
    const response = await request(blobUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-lease-id': leaseId,
      },
      body: serialized,
    });
    if (response.status === 201) {
      return true;
    }
    if (isLeaseConflict(response)) {
      return false;
    }
    throw new BlobLeaseStoreError('storage_request_rejected');
  }

  async function lease(blobUrl, action, leaseId, leaseDurationSeconds) {
    const headers = {
      'x-ms-lease-action': action,
      ...(action === 'acquire'
        ? {
            'x-ms-lease-duration': String(leaseDurationSeconds),
            'x-ms-proposed-lease-id': leaseId,
          }
        : { 'x-ms-lease-id': leaseId }),
    };
    const response = await request(leaseUrl(blobUrl), { method: 'PUT', headers });
    const expectedStatus = action === 'acquire' ? 201 : 200;
    if (response.status === expectedStatus) {
      return response;
    }
    if (isLeaseConflict(response)) {
      return undefined;
    }
    throw new BlobLeaseStoreError('storage_request_rejected');
  }

  async function bestEffortRelease(blobUrl, leaseId) {
    try {
      await lease(blobUrl, 'release', leaseId);
    } catch {
      // A finite lease still provides bounded crash recovery if cleanup cannot reach Storage.
    }
  }

  return Object.freeze({
    async acquire({ key, leaseId, leaseDurationSeconds, record }) {
      const blobUrl = lockBlobUrl(normalizedContainerUrl, key);
      await ensureLockBlob(blobUrl);
      const acquisition = await lease(blobUrl, 'acquire', leaseId, leaseDurationSeconds);
      if (!acquisition) {
        return Object.freeze({ acquired: false, record: await readRecord(blobUrl) });
      }
      const returnedLeaseId = acquisition.headers.get('x-ms-lease-id');
      if (returnedLeaseId?.toLowerCase() !== leaseId.toLowerCase()) {
        await bestEffortRelease(blobUrl, leaseId);
        throw new BlobLeaseStoreError('storage_lease_invalid');
      }
      try {
        if (!(await writeRecord(blobUrl, leaseId, record))) {
          throw new BlobLeaseStoreError('storage_lease_lost');
        }
      } catch (error) {
        await bestEffortRelease(blobUrl, leaseId);
        throw error;
      }
      return Object.freeze({ acquired: true });
    },

    async renew({ key, leaseId, record }) {
      const blobUrl = lockBlobUrl(normalizedContainerUrl, key);
      if (!(await lease(blobUrl, 'renew', leaseId))) {
        return Object.freeze({ renewed: false });
      }
      if (!(await writeRecord(blobUrl, leaseId, record))) {
        return Object.freeze({ renewed: false });
      }
      return Object.freeze({ renewed: true });
    },

    async release({ key, leaseId, record }) {
      const blobUrl = lockBlobUrl(normalizedContainerUrl, key);
      if (!(await writeRecord(blobUrl, leaseId, record))) {
        return Object.freeze({ released: false });
      }
      if (!(await lease(blobUrl, 'release', leaseId))) {
        return Object.freeze({ released: false });
      }
      return Object.freeze({ released: true });
    },
  });
}
