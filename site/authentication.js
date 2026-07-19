const SIGN_IN_SCOPES = Object.freeze(['openid', 'profile', 'email']);

function validateConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object') {
    throw new Error('Authentication configuration is missing.');
  }

  const clientId = configuration.clientId?.trim();
  if (!clientId) {
    throw new Error('Authentication client ID is missing.');
  }

  const authority = configuration.authority?.replace(/\/+$/, '');
  if (authority !== 'https://login.microsoftonline.com/organizations') {
    throw new Error('Authentication must use the Microsoft organizations authority.');
  }

  let redirectUri;
  try {
    redirectUri = new URL(configuration.redirectUri);
  } catch {
    throw new Error('Authentication redirect URI must be an absolute URL.');
  }

  const localHttp =
    redirectUri.protocol === 'http:' &&
    (redirectUri.hostname === '127.0.0.1' || redirectUri.hostname === 'localhost');
  if (redirectUri.protocol !== 'https:' && !localHttp) {
    throw new Error('Authentication redirect URI must use HTTPS, except on localhost.');
  }

  return { authority, clientId, redirectUri: redirectUri.href };
}

function accountsFor(client) {
  return [...client.getAllAccounts()];
}

function currentState(client) {
  const accounts = accountsFor(client);
  const account = client.getActiveAccount();

  if (account) {
    return { status: 'signed-in', account, accounts };
  }
  if (accounts.length > 1) {
    return { status: 'select-account', account: null, accounts };
  }
  return { status: 'signed-out', account: null, accounts };
}

export function describeAccount(account) {
  if (!account) {
    return null;
  }

  return {
    displayName: account.name || account.username || 'Microsoft account',
    username: account.username || 'Not provided',
    tenantId: account.tenantId || 'Not provided',
    homeAccountId: account.homeAccountId,
  };
}

export function formatAuthenticationError(error) {
  const errorCode = String(error?.errorCode || error?.code || '').toLowerCase();

  if (errorCode === 'user_cancelled' || errorCode === 'access_denied') {
    return 'Sign-in was cancelled. Nothing was installed or changed.';
  }
  if (errorCode === 'interaction_in_progress') {
    return 'A sign-in is already in progress. Finish it or reload this page to try again.';
  }
  if (errorCode === 'invalid_client' || errorCode === 'unauthorized_client') {
    return 'After Party sign-in is not configured correctly yet. Please try again later.';
  }
  if (errorCode.includes('network')) {
    return 'Microsoft sign-in could not be reached. Check your connection and try again.';
  }

  const safeCode = errorCode.match(/^[a-z0-9_.-]{1,80}$/)?.[0];
  return safeCode
    ? `Microsoft sign-in could not be completed. Try again. (${safeCode})`
    : 'Microsoft sign-in could not be completed. Try again.';
}

export function createAuthentication({ configuration, createPublicClientApplication }) {
  const { authority, clientId, redirectUri } = validateConfiguration(configuration);
  if (typeof createPublicClientApplication !== 'function') {
    throw new Error('MSAL Browser is unavailable.');
  }

  const client = createPublicClientApplication({
    auth: {
      clientId,
      authority,
      redirectUri,
      postLogoutRedirectUri: redirectUri,
      navigateToLoginRequestUrl: false,
    },
    cache: {
      cacheLocation: 'sessionStorage',
    },
  });

  return {
    async initialize() {
      await client.initialize();
      const redirectResult = await client.handleRedirectPromise();
      if (redirectResult?.account) {
        client.setActiveAccount(redirectResult.account);
      } else if (!client.getActiveAccount()) {
        const accounts = accountsFor(client);
        if (accounts.length === 1) {
          client.setActiveAccount(accounts[0]);
        }
      }
      return currentState(client);
    },

    getState() {
      return currentState(client);
    },

    async signIn() {
      await client.loginRedirect({
        scopes: [...SIGN_IN_SCOPES],
        prompt: 'select_account',
      });
    },

    selectAccount(homeAccountId) {
      const account = accountsFor(client).find(
        (candidate) => candidate.homeAccountId === homeAccountId,
      );
      if (!account) {
        throw new Error('That Microsoft account is no longer available. Sign in again.');
      }
      client.setActiveAccount(account);
      return currentState(client);
    },

    async signOut() {
      const account = client.getActiveAccount();
      if (!account) {
        return;
      }
      await client.logoutRedirect({ account, postLogoutRedirectUri: redirectUri });
    },
  };
}
