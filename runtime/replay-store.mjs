const STORAGE_API_VERSION = '2023-11-03';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ReplayStoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function uuid(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new ReplayStoreError('replay_request_invalid');
  return normalized;
}

function container(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ReplayStoreError('replay_store_unavailable');
  }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) {
    throw new ReplayStoreError('replay_store_unavailable');
  }
  return url.href.replace(/\/+$/, '');
}

export function createBlobReplayStore({
  containerUrl,
  getAccessToken,
  fetch: fetchRequest = globalThis.fetch,
  now = Date.now,
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  const root = container(containerUrl);
  if (
    typeof getAccessToken !== 'function' ||
    typeof fetchRequest !== 'function' ||
    typeof now !== 'function' ||
    typeof randomUUID !== 'function'
  ) {
    throw new ReplayStoreError('replay_store_unavailable');
  }

  return Object.freeze({
    async claim({ tenantId, operatorId, requestId, expiresAt }) {
      const record = Object.freeze({
        schemaVersion: 1,
        tenantId: uuid(tenantId),
        operatorId: uuid(operatorId),
        requestId: uuid(requestId),
        expiresAt: Number(expiresAt),
      });
      const nowSeconds = Math.floor(Number(now()) / 1000);
      if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= nowSeconds) {
        throw new ReplayStoreError('replay_request_invalid');
      }
      let token;
      try {
        token = String(await getAccessToken()).trim();
      } catch {
        throw new ReplayStoreError('replay_store_unavailable');
      }
      if (!token) throw new ReplayStoreError('replay_store_unavailable');
      const url = `${root}/replay/${record.requestId}.json`;
      let response;
      try {
        response = await fetchRequest(url, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'If-None-Match': '*',
            'x-ms-blob-type': 'BlockBlob',
            'x-ms-client-request-id': uuid(randomUUID()),
            'x-ms-date': new Date(now()).toUTCString(),
            'x-ms-version': STORAGE_API_VERSION,
          },
          body: JSON.stringify(record),
        });
      } catch {
        throw new ReplayStoreError('replay_store_unavailable');
      }
      if (response?.status === 201) return true;
      if ([409, 412].includes(response?.status)) return false;
      throw new ReplayStoreError('replay_store_unavailable');
    },
  });
}
