import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLiveLockConfiguration, withDevelopmentLiveLock } from '../scripts/development-live-lock.mjs';
import { driveMicrosoftRedirect, diagnosticUrl, readPublishedVersion, redactText, verifyReviewedConsentApplication } from '../scripts/spa-acceptance.mjs';
import { parseArguments } from '../scripts/run-spa-acceptance.mjs';

function locator({ isVisible = false, click = () => {}, fill = () => {}, count = 0, innerText = '' } = {}) {
  return {
    first() { return this; },
    isVisible: async () => isVisible,
    click: async () => click(),
    fill: async (value) => fill(value),
    count: async () => count,
    innerText: async () => innerText,
  };
}

test('acceptance CLI requires exact immutable identities for live proof', () => {
  const commit = 'a'.repeat(40);
  const image = `ghcr.io/seanewest/after-party-labs/runtime@sha256:${'b'.repeat(64)}`;
  assert.deepEqual(parseArguments(['--mode', 'prove', '--commit', commit, '--runtime-image', image]).expectedCommit, commit);
  assert.throws(() => parseArguments(['--mode', 'prove']), /requires --commit and --runtime-image/);
  assert.equal(parseArguments(['--mode', 'authenticate']).mode, 'authenticate');
});

test('diagnostics remove URL secrets, bearer values, JWTs, and authorization codes', () => {
  const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(30)}.${'c'.repeat(20)}`;
  const text = redactText(`Bearer top-secret access_token=refresh-me code=auth-code ${jwt}`);
  assert.doesNotMatch(text, /top-secret|refresh-me|auth-code|eyJ/);
  assert.equal(diagnosticUrl('https://login.microsoftonline.com/path?code=secret#token'), 'https://login.microsoftonline.com/path');
  assert.doesNotMatch(redactText('{"refresh_token":"secret-value"}'), /secret-value/);
});

test('live lock accepts only the one canonical tenant-wide blob', () => {
  const canonical = {
    storageAccount: 'afterpartylock92563293',
    container: 'live-testing-lock',
    blob: 'tenant.lock',
    blobUrl: 'https://afterpartylock92563293.blob.core.windows.net/live-testing-lock/tenant.lock',
    containerResourceId: '/subscriptions/6d8ebd0e-017f-401e-950d-e5a35de93dc6/resourceGroups/after-test/providers/Microsoft.Storage/storageAccounts/afterpartylock92563293/blobServices/default/containers/live-testing-lock',
  };
  assert.equal(validateLiveLockConfiguration(canonical).blobUrl, canonical.blobUrl);
  assert.throws(() => validateLiveLockConfiguration({ ...canonical, blob: 'another.lock', blobUrl: canonical.blobUrl.replace('tenant.lock', 'another.lock') }), /canonical development-tenant lease/);
});

test('published metadata must identify a full commit and digest-pinned runtime', async () => {
  const commit = 'a'.repeat(40);
  const runtimeImage = `ghcr.io/seanewest/after-party-labs/runtime@sha256:${'b'.repeat(64)}`;
  const version = await readPublishedVersion('https://example.test/', async () => ({ ok: true, json: async () => ({ commit, runtimeImage }) }));
  assert.equal(version.commit, commit);
  await assert.rejects(() => readPublishedVersion('https://example.test/', async () => ({ ok: true, json: async () => ({ commit: 'dirty', runtimeImage }) })), /commit is invalid/);
  await assert.rejects(() => readPublishedVersion('https://example.test/', async () => ({ ok: true, json: async () => ({ commit, runtimeImage: 'latest' }) })), /not digest-pinned/);
});

test('Microsoft steering submits only the dedicated UPN and selects certificate authentication', async () => {
  const upn = 'after-party-operator@corywest.onmicrosoft.com';
  let stage = 'username';
  let filled;
  let accountClicks = 0;
  const page = {
    url: () => stage === 'done' ? 'https://example.test/' : 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9edaa951-658e-4be2-9623-ee906cb604b2',
    waitForLoadState: async () => {},
    locator(selector) {
      if (selector === 'body') return locator({ innerText: stage === 'username' ? 'Sign in' : stage === 'options' ? 'Sign-in options' : stage === 'choice' ? 'Use a certificate or smart card' : 'Signed in' });
      if (selector === '#auth-status') return locator({ count: stage === 'done' ? 1 : 0 });
      if (selector === 'input[name="passwd"]:visible') return locator({ isVisible: stage === 'options' });
      if (selector === 'input[name="loginfmt"]:visible') return locator({ isVisible: stage === 'username' || stage === 'options', fill: (value) => { filled = value; } });
      if (selector === '#idSIButton9, button[type="submit"]') return locator({ click: () => { stage = 'options'; } });
      if (selector.includes('data-value')) return locator();
      if (selector === '#signInAnotherWay') return locator();
      return locator();
    },
    getByText(pattern) {
      const expression = String(pattern);
      if (pattern === upn) return locator({ isVisible: stage === 'options', click: () => { accountClicks += 1; } });
      if (/sign-in options/i.test(expression)) return locator({ isVisible: stage === 'options', click: () => { stage = 'choice'; } });
      if (/certificate/i.test(expression)) return locator({ isVisible: stage === 'choice', click: () => { stage = 'done'; } });
      return locator();
    },
    getByRole() { return locator(); },
  };
  await driveMicrosoftRedirect({ page, spaOrigin: 'https://example.test', userPrincipalName: upn, timeoutMs: 10_000 });
  assert.equal(filled, upn);
  assert.equal(accountClicks, 0);
  assert.equal(stage, 'done');
});

test('Microsoft steering fails closed when a password or Conditional Access page appears', async () => {
  const page = (text, passwordVisible = false) => ({
    url: () => 'https://login.microsoftonline.com/',
    locator(selector) {
      if (selector === 'body') return locator({ innerText: text });
      if (selector === 'input[name="passwd"]:visible') return locator({ isVisible: passwordVisible });
      return locator();
    },
    getByText() { return locator(); },
    getByRole() { return locator(); },
  });
  await assert.rejects(() => driveMicrosoftRedirect({ page: page('Enter password', true), spaOrigin: 'https://example.test', userPrincipalName: 'operator@example.test', timeoutMs: 100 }), /requested a password/);
  await assert.rejects(() => driveMicrosoftRedirect({ page: page('You cannot access this right now. Conditional Access policy.'), spaOrigin: 'https://example.test', userPrincipalName: 'operator@example.test', timeoutMs: 100 }), /Conditional Access blocked/);
});

test('Microsoft steering refuses unplanned consent and the guard verifies the exact reviewed app permissions', async () => {
  const consentPage = {
    url: () => 'https://login.microsoftonline.com/92563293-315c-4b6c-9b90-bcb47ee8c970/adminconsent?client_id=9edaa951-658e-4be2-9623-ee906cb604b2',
    locator(selector) {
      if (selector === 'body') return locator({ innerText: 'Permissions requested by After Party' });
      return locator();
    },
    getByText() { return locator(); },
    getByRole() { return locator(); },
  };
  await assert.rejects(() => driveMicrosoftRedirect({ page: consentPage, spaOrigin: 'https://example.test', userPrincipalName: 'operator@example.test', timeoutMs: 100 }), /unplanned interactive consent/);

  const resources = [
    ['00000003-0000-0000-c000-000000000000', [
      'e1fe6dd8-ba31-4d61-89e7-88639da4683d', 'c5366453-9fb0-48a5-a156-24f0c49a4b84', 'bdfbf15f-ee85-4955-8675-146e8e5296b5', '84bccea3-f856-4a8a-967b-dbe0a3d53a64', '4e46008b-f24c-477d-8fff-7bb4ec7aafe0', '204e0828-b5ca-4ad8-b9f3-f32a958e7cc4', 'd01b97e9-cbc0-49fe-810a-750afd5527a3', 'ad902697-1014-4ef5-81ef-2b4301988e8c', 'e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20', '02e97553-ed7b-43d0-ab3c-f8bace0d040c', '024d486e-b451-40bb-833d-3e66d98c5c73', 'e383f46e-2787-4529-855e-0e479a3ffac0', '863451e7-0667-486c-a5d6-d135439485f0', '89fe6a52-be36-487e-b7d8-d061c450a026', '6aedf524-7e1c-45a7-bd76-ded8cab8d0fc',
    ]],
    ['797f4846-ba00-4fd7-ba43-dac1f8f63013', ['41094075-9dad-400e-a0bd-54e686782033']],
  ].map(([resourceAppId, ids]) => ({ resourceAppId, resourceAccess: ids.map((id) => ({ id, type: 'Scope' })) }));
  const graph = { request: async () => ({ value: [{ appId: '9edaa951-658e-4be2-9623-ee906cb604b2', displayName: 'After Party', signInAudience: 'AzureADMultipleOrgs', requiredResourceAccess: resources }] }) };
  assert.equal(await verifyReviewedConsentApplication(graph), true);
  resources[0].resourceAccess.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'Scope' });
  await assert.rejects(() => verifyReviewedConsentApplication(graph), /permission registration drifted/);
});

test('development live lock renews long runs, releases on success, and aborts on renewal loss', async () => {
  const calls = [];
  const lease = {
    acquire: async () => { calls.push('acquire'); return { leaseId: 'private' }; },
    renew: async () => { calls.push('renew'); },
    release: async () => { calls.push('release'); },
  };
  const result = await withDevelopmentLiveLock({ task: 'test', lease, renewIntervalMs: 5, logger: () => {}, run: async () => { await new Promise((resolveWait) => setTimeout(resolveWait, 14)); return 'done'; } });
  assert.equal(result, 'done');
  assert.equal(calls[0], 'acquire');
  assert.equal(calls.includes('renew'), true);
  assert.equal(calls.at(-1), 'release');

  let renewals = 0;
  const failing = {
    acquire: async () => ({ leaseId: 'private' }),
    renew: async () => { renewals += 1; throw new Error('lost'); },
    release: async () => {},
  };
  await assert.rejects(() => withDevelopmentLiveLock({ task: 'test', lease: failing, renewIntervalMs: 2, logger: () => {}, run: ({ signal }) => new Promise((resolveRun, rejectRun) => signal.addEventListener('abort', () => rejectRun(signal.reason), { once: true })) }), /renewal failed/);
  assert.equal(renewals, 1);
});
