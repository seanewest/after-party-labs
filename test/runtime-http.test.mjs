import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { RuntimeAuthorizationError } from '../runtime/authorization.mjs';
import {
  createRuntimeAuthorizationHandler,
  decodeContainerAppsPrincipal,
} from '../runtime/http.mjs';

function encodedPrincipal(overrides = {}) {
  const values = {
    ver: '2.0',
    tid: '11111111-1111-1111-1111-111111111111',
    oid: '22222222-2222-2222-2222-222222222222',
    iss: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
    aud: '33333333-3333-3333-3333-333333333333',
    azp: '33333333-3333-3333-3333-333333333333',
    scp: 'AfterParty.Operate',
    nbf: '1999999900',
    exp: '2000003600',
    ...overrides,
  };
  const names = {
    tid: 'http://schemas.microsoft.com/identity/claims/tenantid',
    oid: 'http://schemas.microsoft.com/identity/claims/objectidentifier',
    scp: 'http://schemas.microsoft.com/identity/claims/scope',
  };
  return Buffer.from(
    JSON.stringify({
      auth_typ: 'aad',
      claims: Object.entries(values).map(([typ, val]) => ({ typ: names[typ] || typ, val })),
    }),
  ).toString('base64');
}

test('the Container Apps principal adapter preserves only authorization claims', () => {
  const principal = decodeContainerAppsPrincipal(encodedPrincipal({ email: 'operator@example.test' }));
  assert.equal(principal.authenticated, true);
  assert.equal(principal.claims.tid, '11111111-1111-1111-1111-111111111111');
  assert.equal(principal.claims.oid, '22222222-2222-2222-2222-222222222222');
  assert.equal(principal.claims.scp, 'AfterParty.Operate');
  assert.equal(Object.hasOwn(principal.claims, 'email'), false);
  assert.equal(principal.claims.exp, 2_000_003_600);
});

test('duplicate authorization claims are rejected as ambiguous', () => {
  const value = JSON.parse(Buffer.from(encodedPrincipal(), 'base64').toString('utf8'));
  value.claims.push({ typ: 'aud', val: '66666666-6666-6666-6666-666666666666' });
  assert.throws(
    () => decodeContainerAppsPrincipal(Buffer.from(JSON.stringify(value)).toString('base64')),
    (error) => error.code === 'session_invalid',
  );
});

test('the HTTP contract passes platform identity and installation evidence to authorization', async () => {
  const calls = [];
  const result = Object.freeze({ status: 'authorized', requestId: 'request-id' });
  const handler = createRuntimeAuthorizationHandler({
    authorizer: {
      async authorize(value) {
        calls.push(value);
        return result;
      },
    },
    async getInstallation() {
      return { status: 'verified' };
    },
  });

  const response = await handler.handle({
    method: 'POST',
    path: '/operations',
    headers: { 'X-MS-CLIENT-PRINCIPAL': encodedPrincipal() },
    body: { operation: 'runtime.status' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body, result);
  assert.equal(calls[0].principal.claims.scp, 'AfterParty.Operate');
  assert.deepEqual(calls[0].installation, { status: 'verified' });
});

test('malformed principals, authorization failures, and internal errors return fixed codes', async () => {
  const malformedHandler = createRuntimeAuthorizationHandler({
    authorizer: { authorize: async () => ({}) },
    getInstallation: async () => ({}),
  });
  assert.deepEqual(
    await malformedHandler.handle({ method: 'POST', path: '/operations', headers: {}, body: {} }),
    {
      status: 401,
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
      body: { status: 'rejected', code: 'session_invalid' },
    },
  );

  const rejectedHandler = createRuntimeAuthorizationHandler({
    authorizer: {
      async authorize() {
        throw new RuntimeAuthorizationError('wrong_tenant', 403);
      },
    },
    getInstallation: async () => ({}),
  });
  assert.equal(
    (await rejectedHandler.handle({
      method: 'POST',
      path: '/operations',
      headers: { 'x-ms-client-principal': encodedPrincipal() },
      body: {},
    })).body.code,
    'wrong_tenant',
  );

  const unavailableHandler = createRuntimeAuthorizationHandler({
    authorizer: { authorize: async () => ({}) },
    getInstallation: async () => {
      throw new Error('storage account and credential detail');
    },
  });
  const unavailable = await unavailableHandler.handle({
    method: 'POST',
    path: '/operations',
    headers: { 'x-ms-client-principal': encodedPrincipal() },
    body: {},
  });
  assert.deepEqual(unavailable.body, { status: 'rejected', code: 'runtime_unavailable' });
  assert.doesNotMatch(JSON.stringify(unavailable), /storage account|credential detail/);
});
