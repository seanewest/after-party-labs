import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRuntimeApiClient,
  formatRuntimeApiError,
  RuntimeApiError,
} from '../site/runtime-api.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const applicationId = '22222222-2222-2222-2222-222222222222';
const subscriptionId = '33333333-3333-3333-3333-333333333333';
const requestId = '44444444-4444-4444-4444-444444444444';
const commit = 'a'.repeat(40);
const runtimeId = `/subscriptions/${subscriptionId}/resourceGroups/after-party-runtime/providers/Microsoft.App/containerApps/after-party-api`;

function configuration(overrides = {}) {
  return {
    endpoint: 'https://after-party.example.azurecontainerapps.io',
    tenantId,
    runtimeId,
    commit,
    scope: `api://${applicationId}/AfterParty.Operate`,
    ...overrides,
  };
}

function successfulResponse(operation = 'runtime.status') {
  return {
    ok: true,
    async json() {
      return { status: 'authorized', operation, requestId, tenantId, runtimeId, commit };
    },
  };
}

test('the SPA sends one opaque runtime token and exact tenant/version request without retaining it', async () => {
  const calls = [];
  const client = createRuntimeApiClient({
    configuration: configuration(),
    async acquireAccessToken(scope) {
      calls.push(['token', scope]);
      return 'opaque-runtime-access-token';
    },
    async fetchRuntime(url, options) {
      calls.push(['fetch', url, options]);
      return successfulResponse();
    },
    randomUUID: () => requestId,
  });

  const result = await client.run('runtime.status');

  assert.deepEqual(calls[0], ['token', `api://${applicationId}/AfterParty.Operate`]);
  assert.equal(calls[1][1], 'https://after-party.example.azurecontainerapps.io/operations');
  assert.equal(calls[1][2].headers.authorization, 'Bearer opaque-runtime-access-token');
  assert.deepEqual(JSON.parse(calls[1][2].body), {
    operation: 'runtime.status',
    requestId,
    tenantId,
    runtimeId: runtimeId.toLowerCase(),
    commit,
  });
  assert.doesNotMatch(JSON.stringify(result), /opaque-runtime-access-token/);
  assert.equal(result.status, 'authorized');
});

test('wrong-tenant and stale responses are rejected even after HTTP success', async () => {
  for (const body of [
    { status: 'authorized', operation: 'runtime.status', requestId, tenantId: applicationId, runtimeId, commit },
    { status: 'authorized', operation: 'runtime.status', requestId, tenantId, runtimeId, commit: 'b'.repeat(40) },
  ]) {
    const client = createRuntimeApiClient({
      configuration: configuration(),
      acquireAccessToken: async () => 'token',
      fetchRuntime: async () => ({ ok: true, json: async () => body }),
      randomUUID: () => requestId,
    });
    await assert.rejects(client.run('runtime.status'), (error) => error.code === 'runtime_response_invalid');
  }
});

test('unknown server errors and raw failures become fixed safe messages', async () => {
  const cases = [
    [{ ok: false, json: async () => ({ code: 'stale_runtime', message: 'raw details' }) }, 'stale_runtime'],
    [{ ok: false, json: async () => ({ code: 'sql_error', message: 'secret' }) }, 'runtime_unavailable'],
  ];
  for (const [response, code] of cases) {
    const client = createRuntimeApiClient({
      configuration: configuration(),
      acquireAccessToken: async () => 'token',
      fetchRuntime: async () => response,
      randomUUID: () => requestId,
    });
    await assert.rejects(client.run('runtime.status'), (error) => error.code === code);
  }

  assert.equal(
    formatRuntimeApiError(new RuntimeApiError('session_expired')),
    'Your After Party session expired. Sign in again.',
  );
  assert.equal(
    formatRuntimeApiError(new Error('tenant secret')),
    'After Party could not call the tenant runtime.',
  );
});

test('malformed operation and unsafe endpoint configuration fail before token acquisition', async () => {
  let tokenCalls = 0;
  const dependencies = {
    acquireAccessToken: async () => {
      tokenCalls += 1;
      return 'token';
    },
    fetchRuntime: async () => successfulResponse(),
    randomUUID: () => requestId,
  };

  assert.throws(
    () => createRuntimeApiClient({ configuration: configuration({ endpoint: 'http://example.test' }), ...dependencies }),
    (error) => error.code === 'runtime_configuration_invalid',
  );
  const client = createRuntimeApiClient({ configuration: configuration(), ...dependencies });
  await assert.rejects(client.run('../erase'), (error) => error.code === 'operation_not_allowed');
  assert.equal(tokenCalls, 0);
});
