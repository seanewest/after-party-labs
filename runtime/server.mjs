import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { createRuntimeOperationAuthorizer } from './authorization.mjs';
import { createBlobLeaseStore } from './blob-lease-store.mjs';
import { createRuntimeAuthorizationHandler } from './http.mjs';
import { createManagedIdentityCredential } from './managed-identity.mjs';
import { createRuntimeOperationExecutor } from './operations.mjs';
import { createBlobReplayStore } from './replay-store.mjs';
import { createTenantOperationLock } from './tenant-lock.mjs';

const MAX_REQUEST_BYTES = 32 * 1024;
const STORAGE_RESOURCE = 'https://storage.azure.com/';

function required(environment, name) {
  const value = String(environment?.[name] || '').trim();
  if (!value) throw new Error(`Missing runtime setting: ${name}`);
  return value;
}

function json(response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createRuntimeServer({ handler }) {
  if (typeof handler?.handle !== 'function') throw new TypeError('Runtime handler is required.');
  return http.createServer(async (request, response) => {
    let body = {};
    if (request.method === 'POST' && new URL(request.url, 'http://runtime.invalid').pathname === '/operations') {
      try {
        body = await readBody(request);
      } catch {
        json(response, 400, { status: 'rejected', code: 'request_invalid' });
        return;
      }
    }
    const result = await handler.handle({
      method: request.method,
      path: new URL(request.url, 'http://runtime.invalid').pathname,
      headers: request.headers,
      body,
    });
    json(response, result.status, result.body);
  });
}

export function createProductionRuntime({
  environment = process.env,
  fetch = globalThis.fetch,
  now = Date.now,
} = {}) {
  const tenantId = required(environment, 'AFTER_PARTY_TENANT_ID');
  const applicationId = required(environment, 'AFTER_PARTY_APPLICATION_ID');
  const runtimeId = required(environment, 'AFTER_PARTY_RUNTIME_ID');
  const runtimeIdentityClientId = required(environment, 'AFTER_PARTY_RUNTIME_IDENTITY_CLIENT_ID');
  const commit = required(environment, 'AFTER_PARTY_COMMIT');
  const containerUrl = required(environment, 'AFTER_PARTY_STATE_CONTAINER_URL');
  const credential = createManagedIdentityCredential({
    endpoint: required(environment, 'IDENTITY_ENDPOINT'),
    identityHeader: required(environment, 'IDENTITY_HEADER'),
    clientId: required(environment, 'AZURE_CLIENT_ID'),
    fetch,
    now,
  });
  const getStorageToken = () => credential.getToken(STORAGE_RESOURCE);
  const replayStore = createBlobReplayStore({
    containerUrl,
    getAccessToken: getStorageToken,
    fetch,
    now,
    randomUUID,
  });
  const leaseStore = createBlobLeaseStore({
    containerUrl,
    getAccessToken: getStorageToken,
    fetch,
    now,
    randomUUID,
  });
  const lock = createTenantOperationLock({ store: leaseStore, now, randomUUID });
  const authorizer = createRuntimeOperationAuthorizer({
    configuration: {
      tenantId,
      applicationId,
      runtimeId,
      commit,
      allowedOperations: ['runtime.status', 'lock.test'],
    },
    replayStore,
    now,
  });
  const executor = createRuntimeOperationExecutor({ lock, randomUUID });
  return createRuntimeServer({
    handler: createRuntimeAuthorizationHandler({
      authorizer,
      getInstallation: async () => ({
        status: 'verified',
        tenantId,
        applicationId,
        runtimeId,
        commit,
      }),
      runOperation: (authorized) => executor.run(authorized),
    }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT || 3000);
  const server = createProductionRuntime();
  server.listen(port, '0.0.0.0', () => {
    console.log(`After Party runtime listening on port ${port}`);
  });
}
