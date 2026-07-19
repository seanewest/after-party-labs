import {
  createAuthentication,
  describeAccount,
  formatAuthenticationError,
} from './authentication.js';
import {
  createTenantInstallation,
  formatInstallationError,
} from './installation.js';
import { createAzureRuntimeInstaller } from './azure-runtime.js';
import { mountRuntimeCards } from './runtime-cards.js';

const VERIFICATION_STATE_KEY = 'after-party.permission-verification';
const VERIFICATION_STATE_LIFETIME_MS = 10 * 60 * 1000;

function formatVerificationRedirectError(error) {
  const code = String(error?.errorCode || error?.code || '').toLowerCase();
  if (code === 'user_cancelled' || code === 'access_denied') {
    return 'Permission verification was cancelled. Approved tenant permissions were not changed.';
  }
  return formatAuthenticationError(error);
}

export function createSignInController({ authentication, view }) {
  async function run(action) {
    view.setBusy(true);
    try {
      const state = await action();
      if (state) {
        view.render(state);
      }
      return state;
    } catch (error) {
      view.renderError(formatAuthenticationError(error));
      return null;
    } finally {
      view.setBusy(false);
    }
  }

  return {
    initialize: () => run(() => authentication.initialize()),
    signIn: () => run(() => authentication.signIn()),
    signOut: () => run(() => authentication.signOut()),
    selectAccount: (homeAccountId) => run(() => authentication.selectAccount(homeAccountId)),
  };
}

export function createInstallationController({
  authentication,
  installation,
  scopes,
  view,
  currentUrl,
  storage,
  now = () => Date.now(),
}) {
  const expectedScopes = [...scopes];

  function accountIdentity(account) {
    const accountId = String(account?.homeAccountId || '');
    const tenantId = String(account?.tenantId || '').toLowerCase();
    if (!accountId || !tenantId) throw { code: 'account_mismatch' };
    return { accountId, tenantId };
  }

  function savePending(account, callback) {
    const identity = accountIdentity(account);
    if (callback && (
      callback.accountId !== identity.accountId ||
      String(callback.tenantId || '').toLowerCase() !== identity.tenantId
    )) throw { code: 'account_mismatch' };
    storage?.setItem(VERIFICATION_STATE_KEY, JSON.stringify({
      ...identity,
      callback: callback || null,
      createdAt: now(),
      scopes: expectedScopes,
    }));
  }

  function pendingFor(account, required = false) {
    const serialized = storage?.getItem(VERIFICATION_STATE_KEY);
    if (!serialized) {
      if (required) throw { code: 'verification_state_missing' };
      return null;
    }
    let pending;
    try {
      pending = JSON.parse(serialized);
    } catch {
      storage.removeItem(VERIFICATION_STATE_KEY);
      throw { code: 'verification_state_mismatch' };
    }
    const identity = accountIdentity(account);
    const age = now() - pending.createdAt;
    if (!Number.isFinite(pending.createdAt) || age < 0 || age > VERIFICATION_STATE_LIFETIME_MS) {
      storage.removeItem(VERIFICATION_STATE_KEY);
      throw { code: 'verification_state_expired' };
    }
    if (
      pending.accountId !== identity.accountId ||
      pending.tenantId !== identity.tenantId ||
      JSON.stringify(pending.scopes) !== JSON.stringify(expectedScopes)
    ) {
      storage.removeItem(VERIFICATION_STATE_KEY);
      throw { code: 'verification_state_mismatch' };
    }
    return pending;
  }

  async function run(
    action,
    formatError = formatInstallationError,
    renderError = (message) => view.renderInstallationError(message),
  ) {
    view.setInstallationBusy(true);
    try {
      const state = await action();
      if (state) {
        view.renderInstallation(state);
      }
      return state;
    } catch (error) {
      renderError(formatError(error), error);
      return null;
    } finally {
      view.setInstallationBusy(false);
    }
  }

  return {
    initialize: () =>
      run(async () => {
        const callback = installation.consumeCallback(currentUrl());
        const authenticationState = authentication.getState();
        if (authenticationState.status !== 'signed-in') {
          if (!callback) return null;
          throw { code: 'account_mismatch' };
        }
        if (callback) storage?.removeItem(VERIFICATION_STATE_KEY);
        const pending = callback ? null : pendingFor(authenticationState.account);
        const verificationCallback = callback || pending?.callback || null;
        let accessToken;
        try {
          accessToken = await authentication.acquireGraphToken(expectedScopes);
        } catch (error) {
          if (error?.code !== 'interaction_required') throw error;
          savePending(authenticationState.account, verificationCallback);
          return {
            status: 'verification-required',
            tenantId: authenticationState.account.tenantId,
          };
        }
        const verified = !verificationCallback
          ? await installation.verifyCurrent({
            account: authenticationState.account,
            accessToken,
          })
          : await installation.verify({
            account: authenticationState.account,
            accessToken,
            callback: verificationCallback,
          });
        storage?.removeItem(VERIFICATION_STATE_KEY);
        return verified;
      }, formatInstallationError, (message, error) => {
        const code = String(error?.code || '');
        view.renderInstallationError(message, {
          verificationAction: code === 'verification_state_expired' ? 'restart' : null,
        });
      }),

    approve: () =>
      run(() => {
        const authenticationState = authentication.getState();
        if (authenticationState.status !== 'signed-in') {
          throw { code: 'account_mismatch' };
        }
        installation.begin(authenticationState.account);
      }),

    continueVerification: () =>
      run(async () => {
        const authenticationState = authentication.getState();
        if (authenticationState.status !== 'signed-in') throw { code: 'account_mismatch' };
        try {
          pendingFor(authenticationState.account, true);
        } catch (error) {
          if (!['verification_state_missing', 'verification_state_expired'].includes(error?.code)) {
            throw error;
          }
          savePending(authenticationState.account, null);
        }
        await authentication.acquireGraphTokenRedirect(expectedScopes);
      }, (error) =>
        error?.code === 'account_mismatch' || String(error?.code || '').startsWith('verification_state_')
          ? formatInstallationError(error)
          : formatVerificationRedirectError(error),
      (message, error) => {
        const code = String(error?.code || '');
        const blocked = code === 'account_mismatch' || code === 'verification_state_mismatch';
        view.renderInstallationError(message, {
          verificationAction: blocked ? 'none' : 'continue',
        });
      }),

    handleRedirectError(error) {
      const authenticationState = authentication.getState();
      if (authenticationState.status !== 'signed-in') return false;
      let verificationAction = 'continue';
      let stateError = null;
      try {
        pendingFor(authenticationState.account, true);
      } catch (pendingError) {
        stateError = pendingError;
        if (pendingError?.code === 'verification_state_missing') {
          return false;
        }
        if (pendingError?.code === 'verification_state_expired') {
          verificationAction = 'restart';
        } else {
          verificationAction = 'none';
        }
      }
      const message = verificationAction === 'none'
        ? formatInstallationError(stateError)
        : formatVerificationRedirectError(error);
      view.renderInstallationError(message, { verificationAction });
      return true;
    },
  };
}

export function createLazyRuntimeInstaller({ authentication, configuration, fetch }) {
  let installer;

  async function getInstaller() {
    if (!installer) {
      const { createRuntimePlan, verifyRuntimeDeployment } = await import('./runtime/bootstrap.mjs');
      installer = createAzureRuntimeInstaller({
        configuration: {
          applicationClientId: configuration.authentication.clientId,
          apiImage: configuration.runtime.apiImage,
          azureScope: configuration.azureResourceManagerScope,
          commit: configuration.runtime.commit,
          graphScopes: configuration.microsoftGraphDelegatedScopes,
          templateUrl: configuration.runtime.templateUrl,
        },
        acquireAzureToken: (scope) => authentication.acquireAzureManagementToken(scope),
        acquireGraphToken: (scopes) => authentication.acquireGraphToken(scopes),
        fetchArm: fetch,
        fetchGraph: fetch,
        fetchTemplate: fetch,
        createRuntimePlan,
        verifyRuntimeDeployment,
      });
    }
    return installer;
  }

  return Object.freeze(Object.fromEntries(
    ['deploy', 'grantRuntimePermissions', 'listLocations', 'listSubscriptions', 'preflight']
      .map((method) => [method, async (...arguments_) => (await getInstaller())[method](...arguments_)]),
  ));
}

export function handleAuthenticationRedirectError({
  authenticationState,
  installationController,
  view,
}) {
  if (!authenticationState?.redirectError) return false;
  if (!installationController.handleRedirectError(authenticationState.redirectError)) {
    view.renderError(formatAuthenticationError(authenticationState.redirectError));
  }
  return true;
}

function requiredElement(document, id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing page element: ${id}`);
  }
  return element;
}

export function createView(document = globalThis.document) {
  const status = requiredElement(document, 'auth-status');
  const connect = requiredElement(document, 'connect-tenant');
  const signOut = requiredElement(document, 'sign-out');
  const approvePermissions = requiredElement(document, 'approve-permissions');
  const continueVerification = requiredElement(document, 'continue-verification');
  const installationStatus = requiredElement(document, 'installation-status');
  const permissionSummary = requiredElement(document, 'permission-summary');
  const picker = requiredElement(document, 'account-picker');
  const select = requiredElement(document, 'account-select');
  const useAccount = requiredElement(document, 'use-account');
  const details = requiredElement(document, 'account-details');
  const accountName = requiredElement(document, 'account-name');
  const accountUsername = requiredElement(document, 'account-username');
  const tenantId = requiredElement(document, 'tenant-id');
  let busy = true;
  let installationBusy = false;
  let latestState = { status: 'signed-out' };

  function updateButtons() {
    connect.disabled = busy || latestState.status === 'signed-in';
    signOut.disabled = busy;
    useAccount.disabled = busy;
    approvePermissions.disabled = busy || installationBusy;
    continueVerification.disabled = busy || installationBusy;
  }

  return {
    elements: { approvePermissions, connect, continueVerification, signOut, select, useAccount },

    setBusy(value) {
      busy = value;
      updateButtons();
    },

    setInstallationBusy(value) {
      installationBusy = value;
      updateButtons();
    },

    render(state) {
      latestState = state;
      picker.hidden = state.status !== 'select-account';
      details.hidden = state.status !== 'signed-in';
      signOut.hidden = state.status !== 'signed-in';
      connect.hidden = state.status === 'signed-in';
      approvePermissions.hidden = state.status !== 'signed-in';
      continueVerification.hidden = true;
      permissionSummary.hidden = state.status !== 'signed-in';
      if (state.status !== 'signed-in') {
        installationStatus.hidden = true;
      }

      if (state.status === 'signed-in') {
        const account = describeAccount(state.account);
        accountName.textContent = account.displayName;
        accountUsername.textContent = account.username;
        tenantId.textContent = account.tenantId;
        status.textContent =
          'Signed in. Confirm this is the isolated tenant you want to use. No lab-management permissions have been granted yet.';
        status.dataset.kind = 'success';
      } else if (state.status === 'select-account') {
        select.replaceChildren(
          ...state.accounts.map((account) => {
            const option = document.createElement('option');
            const description = describeAccount(account);
            option.value = description.homeAccountId;
            option.textContent = `${description.displayName} — ${description.username}`;
            return option;
          }),
        );
        status.textContent = 'More than one account is available. Choose the tenant administrator you intend to use.';
        status.dataset.kind = 'neutral';
      } else {
        status.textContent = 'No Microsoft account is connected in this browser session.';
        status.dataset.kind = 'neutral';
      }
      updateButtons();
    },

    renderInstallation(state) {
      approvePermissions.hidden = ['installed', 'verification-required'].includes(state.status);
      continueVerification.hidden = state.status !== 'verification-required';
      continueVerification.textContent = 'Continue permission verification';
      permissionSummary.hidden = ['installed', 'verification-required'].includes(state.status);
      installationStatus.hidden = false;
      installationStatus.textContent =
        state.status === 'installed'
          ? `Connected. After Party's lab permissions were verified for tenant ${state.tenantId}.`
          : state.status === 'verification-required'
            ? 'Permission approval finished. Continue verification with Microsoft; approval will not repeat.'
            : 'After Party is ready for permission approval.';
      installationStatus.dataset.kind = state.status === 'installed' ? 'success' : 'neutral';
      updateButtons();
    },

    renderInstallationError(message, { verificationAction = null } = {}) {
      const verificationPending = verificationAction !== null;
      approvePermissions.hidden = verificationPending || latestState.status !== 'signed-in';
      continueVerification.hidden = !['continue', 'restart'].includes(verificationAction);
      continueVerification.textContent = verificationAction === 'restart'
        ? 'Restart permission verification'
        : 'Continue permission verification';
      permissionSummary.hidden = verificationPending || latestState.status !== 'signed-in';
      installationStatus.hidden = false;
      installationStatus.textContent = message;
      installationStatus.dataset.kind = 'error';
      updateButtons();
    },

    renderError(message) {
      latestState = { status: 'error' };
      picker.hidden = true;
      details.hidden = true;
      signOut.hidden = true;
      approvePermissions.hidden = true;
      continueVerification.hidden = true;
      permissionSummary.hidden = true;
      installationStatus.hidden = true;
      connect.hidden = false;
      status.textContent = message;
      status.dataset.kind = 'error';
      updateButtons();
    },
  };
}

export async function startSignInPage() {
  const view = createView();
  const appConfiguration = globalThis.afterPartyConfig;
  const configuration = appConfiguration?.authentication;
  const PublicClientApplication = globalThis.msal?.PublicClientApplication;
  let authentication;
  let installation;
  let runtimeCards;

  try {
    authentication = createAuthentication({
      configuration,
      createPublicClientApplication: (msalConfiguration) =>
        new PublicClientApplication(msalConfiguration),
    });
    installation = createTenantInstallation({
      configuration: {
        clientId: configuration.clientId,
        applicationHomeTenantId: appConfiguration.applicationHomeTenantId,
        displayName: appConfiguration.applicationDisplayName,
        redirectUri: configuration.redirectUri,
        scopes: appConfiguration.microsoftGraphDelegatedScopes,
        azureManagementAppId: '797f4846-ba00-4fd7-ba43-dac1f8f63013',
        azureManagementScope: 'user_impersonation',
      },
      storage: globalThis.sessionStorage,
      navigate: (url) => globalThis.location.assign(url),
      replaceUrl: (url) => globalThis.history.replaceState(null, '', url),
      fetchGraph: globalThis.fetch.bind(globalThis),
      randomUUID: () => globalThis.crypto.randomUUID(),
    });
    runtimeCards = mountRuntimeCards({
      document,
      authentication,
      configuration: appConfiguration,
      container: requiredElement(document, 'experiment-cards'),
      installer: createLazyRuntimeInstaller({
        authentication,
        configuration: appConfiguration,
        fetch: globalThis.fetch.bind(globalThis),
      }),
    });
  } catch (error) {
    view.renderError(formatAuthenticationError(error));
    view.setBusy(false);
    return;
  }

  const controller = createSignInController({ authentication, view });
  const installationController = createInstallationController({
    authentication,
    installation,
    scopes: appConfiguration.microsoftGraphDelegatedScopes,
    view,
    currentUrl: () => globalThis.location.href,
    storage: globalThis.sessionStorage,
  });
  view.elements.connect.addEventListener('click', () => controller.signIn());
  view.elements.signOut.addEventListener('click', () => {
    runtimeCards.reset();
    return controller.signOut();
  });
  view.elements.useAccount.addEventListener('click', async () => {
    const state = await controller.selectAccount(view.elements.select.value);
    if (state?.status === 'signed-in') {
      const installed = await installationController.initialize();
      if (installed?.status === 'installed') await runtimeCards.connect(installed);
    }
  });
  view.elements.approvePermissions.addEventListener('click', () =>
    installationController.approve(),
  );
  view.elements.continueVerification.addEventListener('click', () =>
    installationController.continueVerification(),
  );
  const authenticationState = await controller.initialize();
  if (handleAuthenticationRedirectError({ authenticationState, installationController, view })) {
    runtimeCards.reset();
    return;
  }
  if (authenticationState?.status !== 'signed-in') {
    runtimeCards.reset();
    return;
  }
  const installed = await installationController.initialize();
  if (installed?.status === 'installed') {
    await runtimeCards.connect(installed);
  } else {
    runtimeCards.reset();
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startSignInPage(), { once: true });
  } else {
    await startSignInPage();
  }
}
