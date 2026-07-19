import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRuntimeOperationAuthorizer,
  formatRuntimeAuthorizationError,
  RuntimeAuthorizationError,
} from '../runtime/authorization.mjs';

const tenantId = '11111111-1111-1111-1111-111111111111';
const applicationId = '22222222-2222-2222-2222-222222222222';
const operatorId = '33333333-3333-3333-3333-333333333333';
const subscriptionId = '44444444-4444-4444-4444-444444444444';
const requestId = '55555555-5555-5555-5555-555555555555';
const commit = 'a'.repeat(40);
const runtimeId = `/subscriptions/${subscriptionId}/resourceGroups/after-party-runtime/providers/Microsoft.App/containerApps/after-party-api`;
const now = 2_000_000_000_000;

function configuration(overrides = {}) {
  return {
    tenantId,
    applicationId,
    runtimeId,
    commit,
    allowedOperations: ['runtime.status', 'lock.test'],
    ...overrides,
  };
}

function principal(overrides = {}) {
  return {
    authenticated: true,
    claims: {
      ver: '2.0',
      tid: tenantId,
      oid: operatorId,
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: applicationId,
      azp: applicationId,
      scp: 'AfterParty.Operate',
      nbf: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 3600,
      ...overrides,
    },
  };
}

function request(overrides = {}) {
  return {
    operation: 'runtime.status',
    requestId,
    tenantId,
    runtimeId,
    commit,
    ...overrides,
  };
}

function installation(overrides = {}) {
  return {
    status: 'verified',
    tenantId,
    applicationId,
    runtimeId,
    commit,
    ...overrides,
  };
}

function harness({ claimed = true, configurationOverrides = {} } = {}) {
  const claims = [];
  const authorizer = createRuntimeOperationAuthorizer({
    configuration: configuration(configurationOverrides),
    replayStore: {
      async claim(value) {
        claims.push(value);
        return claimed;
      },
    },
    now: () => now,
  });
  return { authorizer, claims };
}

test('a verified operator is authorized only for the exact tenant runtime and commit', async () => {
  const { authorizer, claims } = harness();

  const result = await authorizer.authorize({
    principal: principal(),
    request: request(),
    installation: installation(),
  });

  assert.deepEqual(result, {
    status: 'authorized',
    operation: 'runtime.status',
    requestId,
    tenantId,
    runtimeId: runtimeId.toLowerCase(),
    commit,
  });
  assert.deepEqual(claims, [
    {
      tenantId,
      operatorId,
      requestId,
      expiresAt: Math.floor(now / 1000) + 3600,
    },
  ]);
});

test('expired, not-yet-valid, and unauthenticated sessions fail before replay state', async () => {
  for (const entry of [
    { principal: principal({ exp: Math.floor(now / 1000) }), code: 'session_expired' },
    { principal: principal({ nbf: Math.floor(now / 1000) + 1 }), code: 'session_expired' },
    { principal: { authenticated: false, claims: {} }, code: 'session_invalid' },
  ]) {
    const { authorizer, claims } = harness();
    await assert.rejects(
      authorizer.authorize({ principal: entry.principal, request: request(), installation: installation() }),
      (error) => error.code === entry.code,
    );
    assert.deepEqual(claims, []);
  }
});

test('issuer, audience, caller application, tenant, and scope claims fail closed', async () => {
  const otherTenant = '66666666-6666-6666-6666-666666666666';
  const cases = [
    [principal({ iss: `https://login.microsoftonline.com/${otherTenant}/v2.0` }), 'session_invalid'],
    [principal({ aud: otherTenant }), 'session_invalid'],
    [principal({ azp: otherTenant }), 'session_invalid'],
    [principal({ tid: otherTenant, iss: `https://login.microsoftonline.com/${otherTenant}/v2.0` }), 'wrong_tenant'],
    [principal({ scp: 'User.Read' }), 'insufficient_scope'],
  ];

  for (const [candidate, code] of cases) {
    const { authorizer, claims } = harness();
    await assert.rejects(
      authorizer.authorize({ principal: candidate, request: request(), installation: installation() }),
      (error) => error.code === code,
    );
    assert.deepEqual(claims, []);
  }
});

test('missing or mismatched installation and stale versions fail before replay state', async () => {
  const cases = [
    [{ status: 'missing' }, 'installation_missing'],
    [installation({ tenantId: '66666666-6666-6666-6666-666666666666' }), 'installation_invalid'],
    [installation({ runtimeId: runtimeId.replace('after-party-api', 'other-api') }), 'installation_invalid'],
    [installation({ commit: 'b'.repeat(40) }), 'stale_runtime'],
    [installation({ applicationId: '66666666-6666-6666-6666-666666666666' }), 'installation_invalid'],
  ];

  for (const [candidate, code] of cases) {
    const { authorizer, claims } = harness();
    await assert.rejects(
      authorizer.authorize({ principal: principal(), request: request(), installation: candidate }),
      (error) => error.code === code,
    );
    assert.deepEqual(claims, []);
  }
});

test('wrong tenant, runtime, commit, operation, and malformed requests fail before replay state', async () => {
  const cases = [
    [request({ tenantId: '66666666-6666-6666-6666-666666666666' }), 'wrong_tenant'],
    [request({ runtimeId: runtimeId.replace('after-party-api', 'other-api') }), 'wrong_runtime'],
    [request({ commit: 'b'.repeat(40) }), 'stale_runtime'],
    [request({ operation: 'tenant.erase' }), 'operation_not_allowed'],
    [{ ...request(), extra: 'unexpected' }, 'request_invalid'],
    [{ ...request(), requestId: 'not-a-uuid' }, 'request_invalid'],
  ];

  for (const [candidate, code] of cases) {
    const { authorizer, claims } = harness();
    await assert.rejects(
      authorizer.authorize({ principal: principal(), request: candidate, installation: installation() }),
      (error) => error.code === code,
    );
    assert.deepEqual(claims, []);
  }
});

test('an atomic replay rejection never reports authorization success', async () => {
  const { authorizer } = harness({ claimed: false });
  await assert.rejects(
    authorizer.authorize({ principal: principal(), request: request(), installation: installation() }),
    (error) => error.code === 'replay_detected' && error.status === 409,
  );
});

test('authorization errors expose only fixed student-facing guidance', () => {
  assert.equal(
    formatRuntimeAuthorizationError(new RuntimeAuthorizationError('stale_runtime')),
    'The SPA and tenant runtime are on different commits. Repair the runtime and retry.',
  );
  assert.equal(
    formatRuntimeAuthorizationError(new Error('raw token and tenant details')),
    'After Party could not authorize this operation.',
  );
});
