import { defineExperimentCard, mountExperimentCards } from './experiments.js';
import { formatAzureRuntimeError } from './azure-runtime.js';
import { createRuntimeApiClient, formatRuntimeApiError } from './runtime-api.js';

const INSTALL_FAILURES = Object.freeze({
  azure_unavailable: 'Azure could not be reached for runtime installation.',
  azure_unauthorized: 'The signed-in operator cannot change the selected subscription.',
  commit_invalid: 'The published SPA version is not deployable.',
  deployment_failed: 'Azure did not complete and verify the runtime deployment.',
  deployment_mismatch: 'Azure deployed resources that do not match this selection.',
  image_invalid: 'The published runtime image is not pinned correctly.',
  insufficient_role: 'The selected subscription does not grant the required Azure role.',
  provider_unavailable: 'A required Azure provider is unavailable.',
  region_unavailable: 'The selected Azure region is unavailable.',
  region_unsupported: 'The selected region does not support every runtime resource.',
  runtime_configuration_invalid: 'The published runtime image or bootstrap configuration is not ready.',
  runtime_permissions_failed: 'The runtime exists, but its tenant permissions were not completely verified.',
  subscription_unavailable: 'The selected subscription is not accessible and enabled.',
  template_invalid: 'The published runtime template is not available for this version.',
  wrong_subscription: 'Azure returned a different subscription than the one selected.',
  wrong_tenant: 'The selected subscription belongs to a different tenant.',
});

const LOCK_FAILURES = Object.freeze({
  installation_missing: 'Install or repair the tenant runtime first.',
  insufficient_scope: 'Reconnect the tenant to grant runtime access.',
  operation_not_allowed: 'This runtime does not expose the lock diagnostic.',
  replay_detected: 'The diagnostic request was already received. Run it again.',
  runtime_configuration_invalid: 'The verified runtime connection is incomplete.',
  runtime_response_invalid: 'The runtime did not return verified lock evidence.',
  runtime_unavailable: 'The tenant runtime could not be reached.',
  session_expired: 'The signed-in session expired.',
  session_invalid: 'The signed-in operator could not be verified.',
  stale_runtime: 'Repair the runtime so it matches this SPA version.',
  wrong_runtime: 'The installed runtime does not match this request.',
  wrong_tenant: 'The installed runtime belongs to a different tenant.',
});

function required(value) {
  return String(value || '').trim();
}

function selectionView(document) {
  const panel = document.getElementById('runtime-selection');
  const subscription = document.getElementById('runtime-subscription');
  const location = document.getElementById('runtime-location');
  const verify = document.getElementById('verify-runtime-selection');
  const confirmation = document.getElementById('confirm-runtime-selection');
  const confirmationRow = document.getElementById('runtime-confirmation-row');
  const status = document.getElementById('runtime-selection-status');
  const summary = document.getElementById('runtime-selection-summary');
  if ([panel, subscription, location, verify, confirmation, confirmationRow, status, summary].some((value) => !value)) {
    throw new Error('Runtime selection controls are incomplete.');
  }
  return Object.freeze({
    elements: { confirmation, location, subscription, verify },
    hide() {
      panel.hidden = true;
    },
    show() {
      panel.hidden = false;
    },
    subscriptions(values) {
      subscription.replaceChildren(...values.map((value) => {
        const option = document.createElement('option');
        option.value = value.id;
        option.textContent = `${value.name} — ${value.id}`;
        return option;
      }));
      subscription.disabled = values.length === 0;
    },
    locations(values) {
      location.replaceChildren(...values.map((value) => {
        const option = document.createElement('option');
        option.value = value.name;
        option.textContent = `${value.displayName} — ${value.name}`;
        return option;
      }));
      location.disabled = values.length === 0;
      verify.disabled = values.length === 0;
    },
    pending(message) {
      status.hidden = false;
      status.dataset.kind = 'neutral';
      status.textContent = message;
      verify.disabled = true;
      confirmation.checked = false;
      confirmationRow.hidden = true;
      summary.hidden = true;
    },
    error(message) {
      status.hidden = false;
      status.dataset.kind = 'error';
      status.textContent = message;
      confirmation.checked = false;
      confirmationRow.hidden = true;
      summary.hidden = true;
    },
    plan(plan) {
      status.hidden = false;
      status.dataset.kind = 'success';
      status.textContent = 'Subscription, tenant, region, providers, and Azure role verified. Confirm this exact target to enable installation.';
      summary.hidden = false;
      summary.replaceChildren(
        ...[
          ['Subscription', `${plan.subscription.name} — ${plan.subscription.id}`],
          ['Tenant', plan.tenant.id],
          ['Region', plan.location],
          ['Required role', plan.authorization.requiredRole],
          ['Commit', plan.deployment.parameters.commit],
          ['Changes', plan.resources.join('; ')],
        ].flatMap(([label, value]) => {
          const term = document.createElement('dt');
          term.textContent = label;
          const description = document.createElement('dd');
          description.textContent = value;
          return [term, description];
        }),
      );
      confirmation.checked = false;
      confirmationRow.hidden = false;
      verify.disabled = false;
    },
  });
}

export function createRuntimeCardsController({ installer, runtimeApiFactory, mountCards, view }) {
  if (!installer || typeof runtimeApiFactory !== 'function' || typeof mountCards !== 'function' || !view) {
    throw new TypeError('Runtime cards require installer, API, card, and view adapters.');
  }
  const state = {
    connection: null,
    plan: null,
    planConfirmed: false,
    runtime: null,
    controllers: [],
  };

  function availabilityForInstall() {
    if (!state.connection) return { available: false, reason: 'Connect and verify the tenant first.' };
    if (!state.plan) return { available: false, reason: 'Select and verify an Azure subscription and region first.' };
    if (!state.planConfirmed) return { available: false, reason: 'Confirm the displayed subscription, tenant, region, role, resources, and commit.' };
    return true;
  }

  function availabilityForLock() {
    if (!state.runtime) return { available: false, reason: 'Install or repair the matching tenant runtime first.' };
    if (state.runtime.tenantId !== state.connection?.tenantId) return { available: false, reason: 'The verified runtime belongs to another tenant.' };
    return true;
  }

  const cards = [
    defineExperimentCard({
      id: 'install-tenant-runtime',
      title: 'Install or repair tenant runtime',
      description: 'Creates or reconciles the tenant-owned Container App API, broad runtime identity, state storage, and lock in the confirmed Azure subscription.',
      requirement: { kind: 'role', label: 'Owner, or Contributor plus Role Based Access Control Administrator' },
      effect: 'write',
      availability: availabilityForInstall,
      actionLabel: 'Install or repair runtime',
      failureSummaries: INSTALL_FAILURES,
      errorGuidance: 'Review the selected tenant, subscription, region, role result, runtime image, and published commit, then verify and confirm the target again.',
      async action() {
        const deployed = await installer.deploy(state.plan);
        state.runtime = await installer.grantRuntimePermissions({
          runtime: deployed,
        });
        refresh();
        return {
          summary: 'The tenant runtime and its broad permissions were installed and verified.',
          tenantId: state.runtime.tenantId,
          version: state.runtime.commit,
          details: [
            { label: 'Subscription', value: `${state.runtime.subscriptionName} — ${state.runtime.subscriptionId}` },
            { label: 'Region', value: state.runtime.location },
            { label: 'API', value: state.runtime.apiUrl },
            { label: 'Runtime identity', value: state.runtime.identityClientId },
          ],
        };
      },
    }),
    defineExperimentCard({
      id: 'test-tenant-lock',
      title: 'Test tenant lock',
      description: 'Uses the installed tenant API to prove one operation owns the shared lock while a competing operation is blocked, then releases it for safe reuse.',
      requirement: { kind: 'permission', label: 'AfterParty.Operate' },
      effect: 'write',
      availability: availabilityForLock,
      actionLabel: 'Test tenant lock',
      failureSummaries: LOCK_FAILURES,
      errorGuidance: 'Repair the runtime if its tenant or commit differs, reconnect if the session expired, then run the diagnostic again.',
      async action() {
        const result = await runtimeApiFactory(state.runtime).run('lock.test');
        if (result.diagnostic?.state !== 'contention-confirmed') {
          throw { code: 'runtime_response_invalid' };
        }
        return {
          summary: 'The tenant lock admitted one operation, blocked its competitor, and recovered for reuse.',
          tenantId: result.tenantId,
          version: result.commit,
          details: [
            { label: 'Lock owner', value: 'Exclusive' },
            { label: 'Competing operation', value: 'Blocked' },
            { label: 'Recovery', value: 'Released' },
          ],
        };
      },
    }),
  ];

  function refresh() {
    for (const controller of state.controllers) controller.prepare();
  }

  async function connect(connection) {
    state.connection = connection;
    state.plan = null;
    state.planConfirmed = false;
    state.runtime = null;
    view.show();
    view.pending('Loading enabled Azure subscriptions for this tenant…');
    try {
      const subscriptions = await installer.listSubscriptions(connection.tenantId);
      view.subscriptions(subscriptions);
      if (!subscriptions.length) {
        view.error('No enabled Azure subscription was found for this tenant.');
        refresh();
        return;
      }
      await selectSubscription(subscriptions[0].id);
    } catch (error) {
      view.error(formatAzureRuntimeError(error));
    }
    refresh();
  }

  async function selectSubscription(subscriptionId) {
    state.plan = null;
    state.planConfirmed = false;
    state.runtime = null;
    view.pending('Loading Azure regions for the selected subscription…');
    try {
      const locations = await installer.listLocations({
        tenantId: state.connection.tenantId,
        subscriptionId,
      });
      view.locations(locations);
      if (!locations.length) view.error('No usable Azure region was returned for this subscription.');
    } catch (error) {
      view.error(formatAzureRuntimeError(error));
    }
    refresh();
  }

  async function verifySelection({ location, subscriptionId }) {
    state.plan = null;
    state.planConfirmed = false;
    state.runtime = null;
    view.pending('Verifying the exact Azure target and effective role without changing it…');
    try {
      state.plan = await installer.preflight({
        tenantId: state.connection.tenantId,
        subscriptionId,
        location,
        resourceGroupName: 'after-party-runtime',
        runtimeName: 'after-party',
      });
      view.plan(state.plan);
    } catch (error) {
      view.error(formatAzureRuntimeError(error));
    }
    refresh();
  }

  function confirm(value) {
    state.planConfirmed = value === true && Boolean(state.plan);
    refresh();
  }

  function changeLocation() {
    state.plan = null;
    state.planConfirmed = false;
    state.runtime = null;
    view.pending('Verify the newly selected Azure region before confirming installation.');
    view.elements.verify.disabled = false;
    refresh();
  }

  function reset() {
    Object.assign(state, { connection: null, plan: null, planConfirmed: false, runtime: null });
    view.hide();
    refresh();
  }

  state.controllers = mountCards(cards);
  refresh();
  return Object.freeze({ changeLocation, confirm, connect, getState: () => state, reset, selectSubscription, verifySelection });
}

export function mountRuntimeCards({ document, installer, authentication, configuration, container }) {
  const view = selectionView(document);
  const controller = createRuntimeCardsController({
    installer,
    view,
    mountCards: (cards) => mountExperimentCards({ document, container, cards }),
    runtimeApiFactory: (runtime) => createRuntimeApiClient({
      configuration: {
        endpoint: runtime.apiUrl,
        tenantId: runtime.tenantId,
        runtimeId: runtime.apiId,
        commit: runtime.commit,
        scope: configuration.runtimeApiScope,
      },
      acquireAccessToken: (scope) => authentication.acquireRuntimeToken(scope),
      fetchRuntime: globalThis.fetch.bind(globalThis),
      randomUUID: () => globalThis.crypto.randomUUID(),
    }),
  });
  view.elements.subscription.addEventListener('change', () =>
    controller.selectSubscription(required(view.elements.subscription.value)),
  );
  view.elements.location.addEventListener('change', () => controller.changeLocation());
  view.elements.verify.addEventListener('click', () => controller.verifySelection({
    subscriptionId: required(view.elements.subscription.value),
    location: required(view.elements.location.value),
  }));
  view.elements.confirmation.addEventListener('change', () =>
    controller.confirm(view.elements.confirmation.checked),
  );
  return controller;
}
