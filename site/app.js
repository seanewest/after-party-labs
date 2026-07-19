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
}) {
  async function run(action) {
    view.setInstallationBusy(true);
    try {
      const state = await action();
      if (state) {
        view.renderInstallation(state);
      }
      return state;
    } catch (error) {
      view.renderInstallationError(formatInstallationError(error));
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
        const accessToken = await authentication.acquireGraphToken(scopes);
        if (!callback) {
          return installation.verifyCurrent({
            account: authenticationState.account,
            accessToken,
          });
        }
        return installation.verify({
          account: authenticationState.account,
          accessToken,
          callback,
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

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing page element: ${id}`);
  }
  return element;
}

function createView() {
  const status = requiredElement('auth-status');
  const connect = requiredElement('connect-tenant');
  const signOut = requiredElement('sign-out');
  const approvePermissions = requiredElement('approve-permissions');
  const installationStatus = requiredElement('installation-status');
  const permissionSummary = requiredElement('permission-summary');
  const picker = requiredElement('account-picker');
  const select = requiredElement('account-select');
  const useAccount = requiredElement('use-account');
  const details = requiredElement('account-details');
  const accountName = requiredElement('account-name');
  const accountUsername = requiredElement('account-username');
  const tenantId = requiredElement('tenant-id');
  let busy = true;
  let installationBusy = false;
  let latestState = { status: 'signed-out' };

  function updateButtons() {
    connect.disabled = busy || latestState.status === 'signed-in';
    signOut.disabled = busy;
    useAccount.disabled = busy;
    approvePermissions.disabled = busy || installationBusy;
  }

  return {
    elements: { approvePermissions, connect, signOut, select, useAccount },

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
      approvePermissions.hidden = state.status === 'installed';
      permissionSummary.hidden = state.status === 'installed';
      installationStatus.hidden = false;
      installationStatus.textContent =
        state.status === 'installed'
          ? `Connected. After Party's lab permissions were verified for tenant ${state.tenantId}.`
          : 'After Party is ready for permission approval.';
      installationStatus.dataset.kind = state.status === 'installed' ? 'success' : 'neutral';
      updateButtons();
    },

    renderInstallationError(message) {
      approvePermissions.hidden = latestState.status !== 'signed-in';
      permissionSummary.hidden = latestState.status !== 'signed-in';
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
      container: requiredElement('experiment-cards'),
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
  const authenticationState = await controller.initialize();
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
