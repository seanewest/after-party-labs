import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAuthentication,
  describeAccount,
  formatAuthenticationError,
} from '../site/authentication.js';
import { createInstallationController, createSignInController } from '../site/app.js';

const configuration = {
  authority: 'https://login.microsoftonline.com/organizations',
  clientId: '9edaa951-658e-4be2-9623-ee906cb604b2',
  redirectUri: 'https://example.test/after-party/',
};

function account(overrides = {}) {
  return {
    homeAccountId: 'home-account-1',
    name: 'Ada Lovelace',
    username: 'ada@example.test',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function fakeMsal({ accounts = [], activeAccount = null, redirectResult = null } = {}) {
  const calls = [];
  let selectedAccount = activeAccount;
  let receivedConfiguration;
  const client = {
    async initialize() {
      calls.push(['initialize']);
    },
    async handleRedirectPromise() {
      calls.push(['handleRedirectPromise']);
      return redirectResult;
    },
    getAllAccounts() {
      return accounts;
    },
    getActiveAccount() {
      return selectedAccount;
    },
    setActiveAccount(value) {
      calls.push(['setActiveAccount', value]);
      selectedAccount = value;
    },
    async loginRedirect(request) {
      calls.push(['loginRedirect', request]);
    },
    async logoutRedirect(request) {
      calls.push(['logoutRedirect', request]);
    },
    async acquireTokenSilent(request) {
      calls.push(['acquireTokenSilent', request]);
      return { accessToken: 'graph-access-token' };
    },
  };

  return {
    calls,
    createPublicClientApplication(value) {
      receivedConfiguration = value;
      return client;
    },
    configuration() {
      return receivedConfiguration;
    },
  };
}

test('authentication uses organizational sign-in and session-scoped MSAL caching', async () => {
  const msal = fakeMsal();
  const authentication = createAuthentication({
    configuration,
    createPublicClientApplication: msal.createPublicClientApplication,
  });

  assert.deepEqual(await authentication.initialize(), {
    status: 'signed-out',
    account: null,
    accounts: [],
  });
  assert.deepEqual(msal.configuration(), {
    auth: {
      clientId: configuration.clientId,
      authority: configuration.authority,
      redirectUri: configuration.redirectUri,
      postLogoutRedirectUri: configuration.redirectUri,
      navigateToLoginRequestUrl: false,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
});

test('redirect completion selects and reports the returned account', async () => {
  const selected = account();
  const msal = fakeMsal({ accounts: [selected], redirectResult: { account: selected } });
  const authentication = createAuthentication({
    configuration,
    createPublicClientApplication: msal.createPublicClientApplication,
  });

  const state = await authentication.initialize();

  assert.equal(state.status, 'signed-in');
  assert.equal(state.account, selected);
  assert.deepEqual(msal.calls.at(-1), ['setActiveAccount', selected]);
});

test('one cached account resumes while multiple accounts require an explicit choice', async () => {
  const first = account();
  const second = account({ homeAccountId: 'home-account-2', username: 'grace@example.test' });
  const singleMsal = fakeMsal({ accounts: [first] });
  const singleAuthentication = createAuthentication({
    configuration,
    createPublicClientApplication: singleMsal.createPublicClientApplication,
  });
  assert.equal((await singleAuthentication.initialize()).account, first);

  const multipleMsal = fakeMsal({ accounts: [first, second] });
  const multipleAuthentication = createAuthentication({
    configuration,
    createPublicClientApplication: multipleMsal.createPublicClientApplication,
  });
  assert.equal((await multipleAuthentication.initialize()).status, 'select-account');
  assert.equal(multipleAuthentication.selectAccount(second.homeAccountId).account, second);
});

test('sign-in requests only identity scopes and always shows account selection', async () => {
  const msal = fakeMsal();
  const authentication = createAuthentication({
    configuration,
    createPublicClientApplication: msal.createPublicClientApplication,
  });

  await authentication.signIn();

  assert.deepEqual(msal.calls.at(-1), [
    'loginRedirect',
    { scopes: ['openid', 'profile', 'email'], prompt: 'select_account' },
  ]);
});

test('sign-out targets only the selected account', async () => {
  const selected = account();
  const msal = fakeMsal({ accounts: [selected], activeAccount: selected });
  const authentication = createAuthentication({
    configuration,
    createPublicClientApplication: msal.createPublicClientApplication,
  });

  await authentication.signOut();

  assert.deepEqual(msal.calls.at(-1), [
    'logoutRedirect',
    { account: selected, postLogoutRedirectUri: configuration.redirectUri },
  ]);
});

test('Graph tokens are acquired silently for the selected tenant and account', async () => {
  const selected = account({ tenantId: '33333333-3333-3333-3333-333333333333' });
  const msal = fakeMsal({ accounts: [selected], activeAccount: selected });
  const authentication = createAuthentication({
    configuration,
    createPublicClientApplication: msal.createPublicClientApplication,
  });

  assert.equal(await authentication.acquireGraphToken(['User.Read']), 'graph-access-token');
  assert.deepEqual(msal.calls.at(-1), [
    'acquireTokenSilent',
    {
      account: selected,
      authority: `https://login.microsoftonline.com/${selected.tenantId}`,
      scopes: ['User.Read'],
    },
  ]);
});

test('runtime tokens are requested only for the reviewed After Party API scope', async () => {
  const selected = account({ tenantId: '33333333-3333-3333-3333-333333333333' });
  const msal = fakeMsal({ accounts: [selected], activeAccount: selected });
  const authentication = createAuthentication({
    configuration,
    createPublicClientApplication: msal.createPublicClientApplication,
  });
  const scope = `api://${configuration.clientId}/AfterParty.Operate`;

  assert.equal(await authentication.acquireRuntimeToken(scope), 'graph-access-token');
  assert.deepEqual(msal.calls.at(-1), [
    'acquireTokenSilent',
    {
      account: selected,
      authority: `https://login.microsoftonline.com/${selected.tenantId}`,
      scopes: [scope],
    },
  ]);
  await assert.rejects(
    authentication.acquireRuntimeToken('https://graph.microsoft.com/User.Read'),
    (error) => error.code === 'token_unavailable',
  );
});

test('Azure management tokens use only the reviewed broad delegated scope', async () => {
  const selected = account({ tenantId: '33333333-3333-3333-3333-333333333333' });
  const msal = fakeMsal({ accounts: [selected], activeAccount: selected });
  const authentication = createAuthentication({
    configuration,
    createPublicClientApplication: msal.createPublicClientApplication,
  });
  const scope = 'https://management.core.windows.net//user_impersonation';

  assert.equal(await authentication.acquireAzureManagementToken(scope), 'graph-access-token');
  assert.deepEqual(msal.calls.at(-1), [
    'acquireTokenSilent',
    {
      account: selected,
      authority: `https://login.microsoftonline.com/${selected.tenantId}`,
      scopes: [scope],
    },
  ]);
  await assert.rejects(
    authentication.acquireAzureManagementToken('https://management.azure.com/.default'),
    (error) => error.code === 'token_unavailable',
  );
});

test('account details expose identity and tenant without token data', () => {
  assert.deepEqual(describeAccount(account()), {
    displayName: 'Ada Lovelace',
    username: 'ada@example.test',
    tenantId: 'tenant-1',
    homeAccountId: 'home-account-1',
  });
});

test('authentication failures become concise student-facing messages', () => {
  assert.equal(
    formatAuthenticationError({ errorCode: 'user_cancelled', message: 'sensitive detail' }),
    'Sign-in was cancelled. No lab-management permissions were granted.',
  );
  assert.equal(
    formatAuthenticationError({ errorCode: 'network_error' }),
    'Microsoft sign-in could not be reached. Check your connection and try again.',
  );
  assert.equal(
    formatAuthenticationError(new Error('sensitive detail')),
    'Microsoft sign-in could not be completed. Try again.',
  );
});

test('unsafe redirect URIs fail before MSAL is created', () => {
  let created = false;
  assert.throws(
    () =>
      createAuthentication({
        configuration: { ...configuration, redirectUri: 'http://example.test/' },
        createPublicClientApplication() {
          created = true;
        },
      }),
    /must use HTTPS/,
  );
  assert.equal(created, false);
});

test('a non-organizational authority fails before MSAL is created', () => {
  assert.throws(
    () =>
      createAuthentication({
        configuration: {
          ...configuration,
          authority: 'https://login.microsoftonline.com/consumers',
        },
        createPublicClientApplication() {
          throw new Error('should not be called');
        },
      }),
    /organizations authority/,
  );
});

test('the sign-in controller reports state transitions through a mockable view', async () => {
  const events = [];
  const controller = createSignInController({
    authentication: {
      async initialize() {
        return { status: 'signed-out', account: null, accounts: [] };
      },
      async signIn() {
        throw { errorCode: 'user_cancelled' };
      },
    },
    view: {
      setBusy(value) {
        events.push(['busy', value]);
      },
      render(state) {
        events.push(['render', state.status]);
      },
      renderError(message) {
        events.push(['error', message]);
      },
    },
  });

  await controller.initialize();
  await controller.signIn();

  assert.deepEqual(events, [
    ['busy', true],
    ['render', 'signed-out'],
    ['busy', false],
    ['busy', true],
    ['error', 'Sign-in was cancelled. No lab-management permissions were granted.'],
    ['busy', false],
  ]);
});

test('the installation controller resumes consent for the same account and renders verification', async () => {
  const selected = account({ tenantId: '33333333-3333-3333-3333-333333333333' });
  const events = [];
  const callback = {
    accountId: selected.homeAccountId,
    tenantId: selected.tenantId,
  };
  const controller = createInstallationController({
    authentication: {
      getState() {
        return { status: 'signed-in', account: selected };
      },
      async acquireGraphToken(scopes) {
        assert.deepEqual(scopes, ['User.Read']);
        return 'access-token';
      },
    },
    installation: {
      consumeCallback(url) {
        assert.equal(url, 'https://example.test/?admin_consent=True');
        return callback;
      },
      async verify(input) {
        assert.deepEqual(input, {
          account: selected,
          accessToken: 'access-token',
          callback,
        });
        return { status: 'installed', tenantId: selected.tenantId };
      },
    },
    scopes: ['User.Read'],
    view: {
      setInstallationBusy(value) {
        events.push(['busy', value]);
      },
      renderInstallation(state) {
        events.push(['render', state.status]);
      },
      renderInstallationError(message) {
        events.push(['error', message]);
      },
    },
    currentUrl: () => 'https://example.test/?admin_consent=True',
  });

  await controller.initialize();

  assert.deepEqual(events, [
    ['busy', true],
    ['render', 'installed'],
    ['busy', false],
  ]);
});

test('the installation controller verifies an already connected tenant without a consent callback', async () => {
  const selected = account({ tenantId: '33333333-3333-3333-3333-333333333333' });
  let verified;
  const controller = createInstallationController({
    authentication: {
      getState: () => ({ status: 'signed-in', account: selected }),
      acquireGraphToken: async () => 'access-token',
    },
    installation: {
      consumeCallback: () => null,
      async verifyCurrent(input) {
        verified = input;
        return {
          status: 'installed',
          tenantId: selected.tenantId,
          servicePrincipalId: '44444444-4444-4444-8444-444444444444',
        };
      },
    },
    scopes: ['User.Read'],
    view: {
      setInstallationBusy() {},
      renderInstallation() {},
      renderInstallationError() {},
    },
    currentUrl: () => 'https://example.test/',
  });

  const state = await controller.initialize();
  assert.equal(state.status, 'installed');
  assert.deepEqual(verified, { account: selected, accessToken: 'access-token' });
});
