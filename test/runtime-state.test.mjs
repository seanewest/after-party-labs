import assert from 'node:assert/strict';
import test from 'node:test';

import { createManagedIdentityCredential } from '../runtime/managed-identity.mjs';
import { createBlobReplayStore } from '../runtime/replay-store.mjs';

const tenantId = '11111111-1111-1111-1111-111111111111';
const operatorId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const storageRequestId = '55555555-5555-4555-8555-555555555555';
const now = 2_000_000_000_000;

test('managed identity tokens are resource-bound, selected by client ID, and cached safely', async () => {
  const calls = [];
  const credential = createManagedIdentityCredential({
    endpoint: 'http://169.254.169.254/msi/token',
    identityHeader: 'platform-secret-header',
    clientId,
    now: () => now,
    async fetch(url, options) {
      calls.push({ url: new URL(url), options });
      return {
        ok: true,
        json: async () => ({
          access_token: 'opaque-storage-token',
          expires_on: String(Math.floor(now / 1000) + 3600),
        }),
      };
    },
  });

  assert.equal(await credential.getToken('https://storage.azure.com/'), 'opaque-storage-token');
  assert.equal(await credential.getToken('https://storage.azure.com/'), 'opaque-storage-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('client_id'), clientId);
  assert.equal(calls[0].url.searchParams.get('resource'), 'https://storage.azure.com/');
  assert.equal(calls[0].options.headers['X-IDENTITY-HEADER'], 'platform-secret-header');
});

test('the Blob replay claim is atomic and stores no token or raw request data', async () => {
  const calls = [];
  const statuses = [201, 412];
  const replayStore = createBlobReplayStore({
    containerUrl: 'https://apstate.blob.core.windows.net/state',
    getAccessToken: async () => 'opaque-storage-token',
    now: () => now,
    randomUUID: () => storageRequestId,
    async fetch(url, options) {
      calls.push({ url, options });
      return { status: statuses.shift() };
    },
  });
  const claim = {
    tenantId,
    operatorId,
    requestId,
    expiresAt: Math.floor(now / 1000) + 3600,
  };

  assert.equal(await replayStore.claim(claim), true);
  assert.equal(await replayStore.claim(claim), false);
  assert.equal(calls[0].url, `https://apstate.blob.core.windows.net/state/replay/${requestId}.json`);
  assert.equal(calls[0].options.headers['If-None-Match'], '*');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer opaque-storage-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { schemaVersion: 1, ...claim });
  assert.doesNotMatch(calls[0].options.body, /opaque-storage-token|authorization/i);
});
