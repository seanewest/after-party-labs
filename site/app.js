import {
  createAuthentication,
  describeAccount,
  formatAuthenticationError,
} from './authentication.js';

export function createSignInController({ authentication, view }) {
  async function run(action) {
    view.setBusy(true);
    try {
      const state = await action();
      if (state) {
        view.render(state);
      }
    } catch (error) {
      view.renderError(formatAuthenticationError(error));
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
  const picker = requiredElement('account-picker');
  const select = requiredElement('account-select');
  const useAccount = requiredElement('use-account');
  const details = requiredElement('account-details');
  const accountName = requiredElement('account-name');
  const accountUsername = requiredElement('account-username');
  const tenantId = requiredElement('tenant-id');
  let busy = true;
  let latestState = { status: 'signed-out' };

  function updateButtons() {
    connect.disabled = busy || latestState.status === 'signed-in';
    signOut.disabled = busy;
    useAccount.disabled = busy;
  }

  return {
    elements: { connect, signOut, select, useAccount },

    setBusy(value) {
      busy = value;
      updateButtons();
    },

    render(state) {
      latestState = state;
      picker.hidden = state.status !== 'select-account';
      details.hidden = state.status !== 'signed-in';
      signOut.hidden = state.status !== 'signed-in';
      connect.hidden = state.status === 'signed-in';

      if (state.status === 'signed-in') {
        const account = describeAccount(state.account);
        accountName.textContent = account.displayName;
        accountUsername.textContent = account.username;
        tenantId.textContent = account.tenantId;
        status.textContent =
          'Signed in. Confirm this is the isolated tenant you want to use. After Party has not been installed yet.';
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

    renderError(message) {
      latestState = { status: 'error' };
      picker.hidden = true;
      details.hidden = true;
      signOut.hidden = true;
      connect.hidden = false;
      status.textContent = message;
      status.dataset.kind = 'error';
      updateButtons();
    },
  };
}

export async function startSignInPage() {
  const view = createView();
  const configuration = globalThis.afterPartyConfig?.authentication;
  const PublicClientApplication = globalThis.msal?.PublicClientApplication;
  let authentication;

  try {
    authentication = createAuthentication({
      configuration,
      createPublicClientApplication: (msalConfiguration) =>
        new PublicClientApplication(msalConfiguration),
    });
  } catch (error) {
    view.renderError(formatAuthenticationError(error));
    view.setBusy(false);
    return;
  }

  const controller = createSignInController({ authentication, view });
  view.elements.connect.addEventListener('click', () => controller.signIn());
  view.elements.signOut.addEventListener('click', () => controller.signOut());
  view.elements.useAccount.addEventListener('click', () =>
    controller.selectAccount(view.elements.select.value),
  );
  await controller.initialize();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startSignInPage(), { once: true });
  } else {
    await startSignInPage();
  }
}
