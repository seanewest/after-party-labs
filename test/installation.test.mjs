import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTenantInstallation,
  formatInstallationError,
} from '../site/installation.js';

const clientId = '11111111-1111-1111-1111-111111111111';
const developerTenantId = '22222222-2222-2222-2222-222222222222';
const studentTenantId = '33333333-3333-3333-3333-333333333333';
const nonce = '44444444-4444-4444-4444-444444444444';
const servicePrincipalId = '55555555-5555-5555-5555-555555555555';
const graphPrincipalId = '66666666-6666-6666-6666-666666666666';
const account = {
  homeAccountId: 'student-account',
  tenantId: studentTenantId,
};
const configuration = {
  clientId,
  developerTenantId,
  displayName: 'After Party',
  redirectUri: 'https://example.test/after-party/',
  scopes: ['User.Read', 'Directory.ReadWrite.All'],
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createHarness({ responses = [], now = 1_000_000, verificationAttempts = 1 } = {}) {
  let currentNow = now;
  const values = new Map();
  const navigations = [];
  const replacements = [];
  const requests = [];
  const installation = createTenantInstallation({
    configuration,
    storage: {
      getItem(key) {
        return values.get(key) ?? null;
      },
      removeItem(key) {
        values.delete(key);
      },
      setItem(key, value) {
        values.set(key, value);
      },
    },
    navigate(url) {
      navigations.push(url);
    },
    replaceUrl(url) {
      replacements.push(url);
    },
    async fetchGraph(url, options) {
      requests.push({ url, options });
      const next = responses.shift();
      if (!next) {
        throw new Error('Unexpected Graph request');
      }
      return next;
    },
    randomUUID: () => nonce,
    now: () => currentNow,
    delay: async () => {},
    verificationAttempts,
    verificationDelayMs: 0,
  });
  return {
    installation,
    navigations,
    replacements,
    requests,
    setNow(value) {
      currentNow = value;
    },
    values,
  };
}

function successfulResponses(overrides = {}) {
  const servicePrincipal = {
    id: servicePrincipalId,
    appId: clientId,
    appOwnerOrganizationId: developerTenantId,
    displayName: 'After Party',
    servicePrincipalType: 'Application',
    ...overrides.servicePrincipal,
  };
  return [
    response({ value: overrides.servicePrincipals ?? [servicePrincipal] }),
    response({ value: [{ id: graphPrincipalId, appId: '00000003-0000-0000-c000-000000000000' }] }),
    response({
      value: overrides.grants ?? [
        {
          clientId: servicePrincipalId,
          consentType: 'AllPrincipals',
          principalId: null,
          resourceId: graphPrincipalId,
          scope: 'openid profile User.Read Directory.ReadWrite.All',
        },
      ],
    }),
    response({ value: overrides.appRoleAssignments ?? [] }),
  ];
}

function consentCallback(state = nonce, tenant = studentTenantId) {
  const url = new URL(configuration.redirectUri);
  url.searchParams.set('admin_consent', 'True');
  url.searchParams.set('tenant', tenant);
  url.searchParams.set('state', state);
  return url.href;
}

test('admin consent is tenant-specific, static, and protected by one-time state', () => {
  const harness = createHarness();

  harness.installation.begin(account);

  const url = new URL(harness.navigations[0]);
  assert.equal(
    url.origin + url.pathname,
    `https://login.microsoftonline.com/${studentTenantId}/v2.0/adminconsent`,
  );
  assert.equal(url.searchParams.get('client_id'), clientId);
  assert.equal(url.searchParams.get('scope'), 'https://graph.microsoft.com/.default');
  assert.equal(url.searchParams.get('redirect_uri'), configuration.redirectUri);
  assert.equal(url.searchParams.get('state'), nonce);

  assert.deepEqual(harness.installation.consumeCallback(consentCallback()), {
    accountId: account.homeAccountId,
    tenantId: studentTenantId,
  });
  assert.deepEqual(harness.replacements, [configuration.redirectUri]);
  assert.throws(
    () => harness.installation.consumeCallback(consentCallback()),
    (error) => error.code === 'consent_state_missing',
  );
});

test('consent callbacks fail closed for mismatched state, tenant, expiry, and denial', () => {
  const cases = [
    { callback: () => consentCallback('77777777-7777-7777-7777-777777777777'), code: 'consent_state_mismatch' },
    { callback: () => consentCallback(nonce, '88888888-8888-8888-8888-888888888888'), code: 'tenant_mismatch' },
    { callback: () => consentCallback(), code: 'consent_state_expired', afterBeginNow: 2_000_000 },
    { callback: () => consentCallback(), code: 'consent_state_expired', afterBeginNow: 999_999 },
    {
      callback: () => {
        const url = new URL(configuration.redirectUri);
        url.searchParams.set('error', 'access_denied');
        url.searchParams.set('state', nonce);
        return url.href;
      },
      code: 'consent_cancelled',
    },
  ];

  for (const entry of cases) {
    const harness = createHarness({ now: entry.now });
    harness.installation.begin(account);
    if (entry.afterBeginNow) {
      harness.setNow(entry.afterBeginNow);
    }
    assert.throws(
      () => harness.installation.consumeCallback(entry.callback()),
      (error) => error.code === entry.code,
    );
  }
});

test('verification requires the exact enterprise application and complete delegated grant', async () => {
  const harness = createHarness({ responses: successfulResponses() });
  const result = await harness.installation.verify({
    account,
    accessToken: 'access-token',
    callback: { accountId: account.homeAccountId, tenantId: studentTenantId },
  });

  assert.deepEqual(result, {
    status: 'installed',
    tenantId: studentTenantId,
    servicePrincipalId,
    grantedScopes: configuration.scopes,
  });
  assert.equal(harness.requests.length, 4);
  assert.equal(
    new URL(harness.requests[0].url).searchParams.get('$filter'),
    `appId eq '${clientId}'`,
  );
  assert.deepEqual(harness.requests[0].options.headers, {
    Authorization: 'Bearer access-token',
  });
});

test('verification retries while the new enterprise application and grant propagate', async () => {
  const harness = createHarness({
    responses: [
      response({ value: [] }),
      ...successfulResponses(),
    ],
    verificationAttempts: 2,
  });

  const result = await harness.installation.verify({
    account,
    accessToken: 'access-token',
    callback: { accountId: account.homeAccountId, tenantId: studentTenantId },
  });

  assert.equal(result.status, 'installed');
  assert.equal(harness.requests.length, 5);
});

test('verification is idempotent for an existing correct installation', async () => {
  const harness = createHarness({
    responses: [...successfulResponses(), ...successfulResponses()],
  });
  const input = {
    account,
    accessToken: 'access-token',
    callback: { accountId: account.homeAccountId, tenantId: studentTenantId },
  };

  assert.equal((await harness.installation.verify(input)).status, 'installed');
  assert.equal((await harness.installation.verify(input)).status, 'installed');
  assert.equal(harness.requests.length, 8);
});

test('verification rejects missing, duplicate, and mismatched enterprise applications', async () => {
  const cases = [
    { responses: successfulResponses({ servicePrincipals: [] }), code: 'enterprise_app_missing' },
    {
      responses: successfulResponses({
        servicePrincipals: [{ id: servicePrincipalId }, { id: graphPrincipalId }],
      }),
      code: 'enterprise_app_duplicate',
    },
    {
      responses: successfulResponses({ servicePrincipal: { servicePrincipalType: 'ManagedIdentity' } }),
      code: 'enterprise_app_mismatch',
    },
  ];

  for (const entry of cases) {
    const harness = createHarness({ responses: entry.responses });
    await assert.rejects(
      harness.installation.verify({
        account,
        accessToken: 'access-token',
        callback: { accountId: account.homeAccountId, tenantId: studentTenantId },
      }),
      (error) => error.code === entry.code,
    );
  }
});

test('verification rejects partial delegated consent and any app-only grant', async () => {
  const partialHarness = createHarness({
    responses: successfulResponses({
      grants: [
        {
          clientId: servicePrincipalId,
          consentType: 'AllPrincipals',
          principalId: null,
          resourceId: graphPrincipalId,
          scope: 'User.Read',
        },
      ],
    }),
  });
  await assert.rejects(
    partialHarness.installation.verify({
      account,
      accessToken: 'access-token',
      callback: { accountId: account.homeAccountId, tenantId: studentTenantId },
    }),
    (error) => error.code === 'delegated_grant_partial',
  );

  const appOnlyHarness = createHarness({
    responses: successfulResponses({
      appRoleAssignments: [{ id: 'assignment', appRoleId: 'role', resourceId: graphPrincipalId }],
    }),
  });
  await assert.rejects(
    appOnlyHarness.installation.verify({
      account,
      accessToken: 'access-token',
      callback: { accountId: account.homeAccountId, tenantId: studentTenantId },
    }),
    (error) => error.code === 'application_grant_unexpected',
  );
});

test('verification reports missing consent and insufficient verification rights', async () => {
  const missingGrantHarness = createHarness({
    responses: successfulResponses({ grants: [] }),
  });
  await assert.rejects(
    missingGrantHarness.installation.verify({
      account,
      accessToken: 'access-token',
      callback: { accountId: account.homeAccountId, tenantId: studentTenantId },
    }),
    (error) => error.code === 'delegated_grant_missing',
  );

  const unauthorizedHarness = createHarness({ responses: [response({}, 403)] });
  await assert.rejects(
    unauthorizedHarness.installation.verify({
      account,
      accessToken: 'access-token',
      callback: { accountId: account.homeAccountId, tenantId: studentTenantId },
    }),
    (error) => {
      assert.match(formatInstallationError(error), /tenant administrator/i);
      return error.code === 'verification_unauthorized';
    },
  );
});

test('verification rejects a callback for a different signed-in account before Graph access', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.installation.verify({
      account,
      accessToken: 'access-token',
      callback: { accountId: 'different-account', tenantId: studentTenantId },
    }),
    (error) => error.code === 'account_mismatch',
  );
  assert.equal(harness.requests.length, 0);
  assert.match(formatInstallationError({ code: 'account_mismatch' }), /different account/i);
});

test('verification fails closed when Microsoft Graph returns a malformed collection', async () => {
  const harness = createHarness({ responses: [response({})] });

  await assert.rejects(
    harness.installation.verify({
      account,
      accessToken: 'access-token',
      callback: { accountId: account.homeAccountId, tenantId: studentTenantId },
    }),
    (error) => error.code === 'graph_unavailable',
  );
});
