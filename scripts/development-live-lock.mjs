import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ClientCertificateCredential } from '@azure/identity';

import { loadDevelopmentAdmin } from './development-admin.mjs';

const STORAGE_SCOPE = 'https://storage.azure.com/.default';
const STORAGE_API_VERSION = '2023-11-03';
const DEVELOPMENT_SUBSCRIPTION_ID = '6d8ebd0e-017f-401e-950d-e5a35de93dc6';
const CANONICAL_LOCK = Object.freeze({
  storageAccount: 'afterpartylock92563293',
  container: 'live-testing-lock',
  blob: 'tenant.lock',
  blobUrl: 'https://afterpartylock92563293.blob.core.windows.net/live-testing-lock/tenant.lock',
  containerResourceId: '/subscriptions/6d8ebd0e-017f-401e-950d-e5a35de93dc6/resourceGroups/after-test/providers/Microsoft.Storage/storageAccounts/afterpartylock92563293/blobServices/default/containers/live-testing-lock',
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function defaultLiveLockConfigPath(environment = process.env) {
  return resolve(
    environment.XDG_CONFIG_HOME || resolve(homedir(), '.config'),
    'after-party',
    'graph-admin',
    'live-testing-lock.json',
  );
}

function pathIsInside(parent, candidate) {
  const within = relative(resolve(parent), resolve(candidate));
  return within === '' || (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within));
}

export function validateLiveLockConfiguration(value) {
  const config = value && typeof value === 'object' ? value : {};
  for (const [key, expected] of Object.entries(CANONICAL_LOCK)) {
    if (config[key] !== expected) throw new Error(`Live lock ${key} does not identify the canonical development-tenant lease.`);
  }
  if (!/^[a-z0-9]{3,24}$/.test(config.storageAccount || '')) throw new Error('Live lock storage account is invalid.');
  if (!/^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(config.container || '')) throw new Error('Live lock container is invalid.');
  if (!/^[^/?#]{1,256}$/.test(config.blob || '')) throw new Error('Live lock blob is invalid.');
  const expected = `https://${config.storageAccount}.blob.core.windows.net/${config.container}/${encodeURIComponent(config.blob)}`;
  if (config.blobUrl !== expected) throw new Error('Live lock URL does not match the configured storage target.');
  const resourcePattern = new RegExp(`^/subscriptions/${DEVELOPMENT_SUBSCRIPTION_ID}/resourceGroups/[^/]+/providers/Microsoft\\.Storage/storageAccounts/${config.storageAccount}/blobServices/default/containers/${config.container}$`, 'i');
  if (!resourcePattern.test(config.containerResourceId || '')) throw new Error('Live lock container is outside the authorized development subscription or does not match its URL.');
  return Object.freeze({ blobUrl: expected, subscriptionId: DEVELOPMENT_SUBSCRIPTION_ID });
}

export async function loadLiveLockConfiguration({
  configPath = defaultLiveLockConfigPath(),
  repositoryRoot = process.cwd(),
} = {}) {
  const resolvedPath = resolve(configPath);
  const actualPath = await realpath(resolvedPath);
  if (pathIsInside(repositoryRoot, actualPath)) throw new Error('Live lock configuration must remain outside Git.');
  const details = await stat(actualPath);
  if (!details.isFile() || (process.platform !== 'win32' && (details.mode & 0o077) !== 0)) {
    throw new Error('Live lock configuration must be an owner-only file.');
  }
  return Object.freeze({
    configPath: actualPath,
    config: validateLiveLockConfiguration(JSON.parse(await readFile(actualPath, 'utf8'))),
  });
}

function decodeClaim(token, claim) {
  const segment = String(token || '').split('.')[1];
  if (!segment) throw new Error('Storage access token is not a JWT.');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))[claim];
}

export function createDevelopmentLease({
  administrator,
  lock,
  credential = new ClientCertificateCredential(
    administrator.config.tenantId,
    administrator.config.clientId,
    administrator.config.certificatePath,
  ),
  fetchImpl = fetch,
  now = () => new Date(),
  uuid = randomUUID,
} = {}) {
  if (administrator.config.subscriptionId.toLowerCase() !== lock.config.subscriptionId.toLowerCase()) {
    throw new Error('Development administrator and live lock target different subscriptions.');
  }
  async function request(action, leaseId) {
    const token = await credential.getToken(STORAGE_SCOPE);
    if (!token?.token) throw new Error('Development Admin did not receive an Azure Storage token.');
    if (String(decodeClaim(token.token, 'tid') || '').toLowerCase() !== administrator.config.tenantId.toLowerCase()) throw new Error('Storage token belongs to another tenant.');
    const applicationId = String(decodeClaim(token.token, 'appid') || decodeClaim(token.token, 'azp') || '');
    if (applicationId.toLowerCase() !== administrator.config.clientId.toLowerCase()) throw new Error('Storage token belongs to another application.');
    const response = await fetchImpl(`${lock.config.blobUrl}?comp=lease`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token.token}`,
        'x-ms-date': now().toUTCString(),
        'x-ms-version': STORAGE_API_VERSION,
        'x-ms-lease-action': action,
        ...(action === 'acquire' ? {
          'x-ms-lease-duration': '30',
          'x-ms-proposed-lease-id': leaseId,
        } : { 'x-ms-lease-id': leaseId }),
      },
    });
    if (!response.ok) {
      const code = response.headers.get('x-ms-error-code') || `HTTP ${response.status}`;
      const error = new Error(action === 'acquire' && response.status === 409
        ? 'Another development live operation owns the tenant-wide lock.'
        : `Tenant-wide lock ${action} failed (${code}).`);
      error.status = response.status;
      throw error;
    }
  }

  return Object.freeze({
    async acquire() {
      const leaseId = uuid();
      if (!UUID_PATTERN.test(leaseId)) throw new Error('Generated live lock lease ID is invalid.');
      await request('acquire', leaseId);
      return Object.freeze({ leaseId });
    },
    renew: (handle) => request('renew', handle.leaseId),
    release: (handle) => request('release', handle.leaseId),
  });
}

export async function withDevelopmentLiveLock({
  task,
  run,
  repositoryRoot = process.cwd(),
  administratorConfigPath,
  lockConfigPath,
  lease,
  renewIntervalMs = 10_000,
  logger = (message) => console.log(`[live-lock] ${message}`),
} = {}) {
  if (!task || typeof run !== 'function') throw new Error('A named live task and callback are required.');
  const activeLease = lease || createDevelopmentLease({
    administrator: await loadDevelopmentAdmin({ configPath: administratorConfigPath, repositoryRoot }),
    lock: await loadLiveLockConfiguration({ configPath: lockConfigPath, repositoryRoot }),
  });
  const abortController = new AbortController();
  let handle;
  let timer;
  let renewing;
  let renewalError;
  const renew = async () => {
    if (abortController.signal.aborted) return;
    try {
      renewing = activeLease.renew(handle);
      await renewing;
      logger(`renewed for ${task}`);
      if (!abortController.signal.aborted) timer = setTimeout(renew, renewIntervalMs);
    } catch (error) {
      renewalError = error;
      abortController.abort(new Error(`Tenant-wide lock renewal failed: ${error.message}`));
    } finally {
      renewing = undefined;
    }
  };
  try {
    handle = await activeLease.acquire();
    logger(`acquired for ${task} by ${userInfo().username}@${hostname()}`);
    timer = setTimeout(renew, renewIntervalMs);
    const result = await run({ signal: abortController.signal });
    if (renewalError) throw renewalError;
    return result;
  } finally {
    clearTimeout(timer);
    abortController.abort(new Error('Live operation finished.'));
    await renewing?.catch(() => {});
    if (handle) {
      try {
        await activeLease.release(handle);
        logger(`released for ${task}`);
      } catch (error) {
        logger(`release failed for ${task}; the fixed lease will expire automatically`);
        throw error;
      }
    }
  }
}
