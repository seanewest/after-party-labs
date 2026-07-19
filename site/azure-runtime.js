const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_PATTERN = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/i;
const ARM = 'https://management.azure.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const PROVIDERS = Object.freeze(['Microsoft.App', 'Microsoft.ManagedIdentity', 'Microsoft.Storage']);
const TERMINAL_STATES = new Set(['Succeeded', 'Failed', 'Canceled']);

export const RUNTIME_API_ROLE_ID = 'f2b4a169-9f29-48c3-b0db-8c5efc1b895b';

export const RUNTIME_GRAPH_APPLICATION_ROLES = Object.freeze({
  'Application.ReadWrite.All': '1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9',
  'AuditLog.Read.All': 'b0afded3-3588-46d8-8b3d-9842eff778da',
  'Directory.ReadWrite.All': '19dbc75e-c2e2-444c-a770-ec69d8559fc7',
  'Files.ReadWrite.All': '75359482-378d-4052-8f01-80520e7db3cd',
  'Group.ReadWrite.All': '62a82d76-70ea-41e2-9197-370581804d09',
  'Mail.ReadWrite': 'e2a3a72e-5f79-4c64-b1b1-878b674786c9',
  'Mail.Send': 'b633e1c5-b582-4048-a93e-9f11b44c7e96',
  'Policy.ReadWrite.ConditionalAccess': '01c0a623-fc9b-48e9-b794-0756f8e8f067',
  'Reports.Read.All': '230c1aed-a721-4c5d-9cb4-a90514e508ef',
  'RoleManagement.ReadWrite.Directory': '9e3f62cf-ca93-4989-b6ce-bf83c28f9fe8',
  'SecurityEvents.ReadWrite.All': 'd903a879-88e0-4c09-b0c9-82f6a1333f84',
  'Sites.ReadWrite.All': '9492366f-7969-46a4-8d15-ed1a20078fff',
  'User.ReadWrite.All': '741f803b-c850-494e-b5df-cde7c675a1ca',
});

export class AzureRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new AzureRuntimeError(code);
}

function uuid(value, code = 'runtime_configuration_invalid') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) fail(code);
  return normalized;
}

function normalizeConfiguration(configuration) {
  const scope = String(configuration?.azureScope || '');
  const image = String(configuration?.apiImage || '').toLowerCase();
  const commit = String(configuration?.commit || '').toLowerCase();
  if (
    scope !== 'https://management.core.windows.net//user_impersonation' ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    !IMAGE_PATTERN.test(image) ||
    /@sha256:0{64}$/.test(image)
  ) {
    fail('runtime_configuration_invalid');
  }
  return Object.freeze({
    applicationClientId: uuid(configuration.applicationClientId),
    apiImage: image,
    azureScope: scope,
    commit,
    graphScopes: Object.freeze([...(configuration.graphScopes || [])]),
    runtimeApiRoleId: uuid(configuration.runtimeApiRoleId),
    templateUrl: new URL(configuration.templateUrl, globalThis.location?.href || 'https://example.invalid/').href,
  });
}

function armUrl(path, apiVersion) {
  const url = new URL(path, ARM);
  url.searchParams.set('api-version', apiVersion);
  return url.href;
}

async function jsonResponse(fetcher, url, options, code, unauthorizedCode = 'azure_unauthorized') {
  let response;
  try {
    response = await fetcher(url, options);
  } catch {
    fail(code);
  }
  if (!response?.ok) {
    if ([401, 403].includes(response?.status)) fail(unauthorizedCode);
    fail(code);
  }
  try {
    return { body: await response.json(), response };
  } catch {
    fail(code);
  }
}

function bearer(token, extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

function parameterValues(parameters) {
  return Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => [name, { value }]),
  );
}

function assignmentKey(value) {
  return `${String(value.resourceId || '').toLowerCase()}:${String(value.appRoleId || '').toLowerCase()}`;
}

export function formatAzureRuntimeError(error) {
  const messages = {
    azure_unavailable: 'Azure Resource Manager could not be reached. Try again shortly.',
    azure_unauthorized: 'The signed-in operator cannot inspect or change the selected Azure subscription.',
    deployment_failed: 'Azure did not complete the tenant runtime deployment.',
    deployment_mismatch: 'Azure returned a runtime that does not match the confirmed target.',
    image_invalid: 'The published runtime image is not pinned correctly.',
    insufficient_role: 'The signed-in operator does not have the required Azure role on this subscription.',
    provider_unavailable: 'Azure could not confirm a required resource provider for this subscription.',
    region_unavailable: 'Choose an Azure region available to this subscription.',
    region_unsupported: 'The selected region does not support every required runtime resource.',
    subscription_unavailable: 'The selected Azure subscription is not accessible and enabled.',
    wrong_subscription: 'Azure returned a different subscription. Select the intended subscription again.',
    wrong_tenant: 'The selected Azure subscription belongs to a different tenant.',
    graph_unavailable: 'Microsoft Graph could not grant or verify the runtime identity permissions.',
    runtime_configuration_invalid: 'The published runtime image or bootstrap configuration is not ready.',
    runtime_permissions_failed: 'The runtime was deployed, but its broad tenant permissions were not completely verified. Run repair again.',
    template_invalid: 'The published runtime template does not match this version of After Party.',
  };
  return messages[error?.code] || 'After Party could not install or verify the tenant runtime.';
}

export function createAzureRuntimeInstaller({
  configuration,
  acquireAzureToken,
  acquireGraphToken,
  fetchArm,
  fetchGraph,
  fetchTemplate,
  createRuntimePlan,
  verifyRuntimeDeployment,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  deploymentAttempts = 150,
  propagationAttempts = 30,
}) {
  const expected = normalizeConfiguration(configuration);
  if (
    ![acquireAzureToken, acquireGraphToken, fetchArm, fetchGraph, fetchTemplate, createRuntimePlan, verifyRuntimeDeployment, delay]
      .every((value) => typeof value === 'function')
  ) fail('runtime_configuration_invalid');

  async function azureToken() {
    try {
      const token = await acquireAzureToken(expected.azureScope);
      if (!token) fail('azure_unauthorized');
      return token;
    } catch (error) {
      if (error instanceof AzureRuntimeError) throw error;
      fail('azure_unauthorized');
    }
  }

  async function arm(token, path, apiVersion, options = {}) {
    return (await jsonResponse(fetchArm, armUrl(path, apiVersion), {
      cache: 'no-store',
      redirect: 'error',
      ...options,
      headers: bearer(token, options.body ? { 'content-type': 'application/json' } : {}),
    }, 'azure_unavailable')).body;
  }

  async function listSubscriptions(tenantId) {
    const selectedTenant = uuid(tenantId, 'wrong_tenant');
    const token = await azureToken();
    const result = await arm(token, '/subscriptions', '2022-12-01');
    if (!Array.isArray(result?.value)) fail('azure_unavailable');
    return Object.freeze(result.value
      .filter((entry) => String(entry?.tenantId || '').toLowerCase() === selectedTenant)
      .map((entry) => Object.freeze({
        id: uuid(entry.subscriptionId, 'subscription_unavailable'),
        name: String(entry.displayName || '').trim(),
        state: String(entry.state || ''),
        tenantId: selectedTenant,
      }))
      .filter((entry) => entry.name && entry.state.toLowerCase() === 'enabled'));
  }

  async function preflight(request) {
    const subscriptionId = uuid(request?.subscriptionId, 'subscription_unavailable');
    const token = await azureToken();
    const root = `/subscriptions/${subscriptionId}`;
    const [subscription, locations, permissions, ...providers] = await Promise.all([
      arm(token, root, '2022-12-01'),
      arm(token, `${root}/locations`, '2022-12-01'),
      arm(token, `${root}/providers/Microsoft.Authorization/permissions`, '2022-04-01'),
      ...PROVIDERS.map((namespace) => arm(token, `${root}/providers/${namespace}`, '2021-04-01')),
    ]);
    try {
      return createRuntimePlan({
        request: {
          ...request,
          applicationClientId: expected.applicationClientId,
          commit: expected.commit,
          apiImage: expected.apiImage,
        },
        evidence: {
          subscription,
          locations: locations?.value,
          permissions: permissions?.value,
          providers,
        },
      });
    } catch (error) {
      throw error;
    }
  }

  async function listLocations({ tenantId, subscriptionId }) {
    const selectedTenant = uuid(tenantId, 'wrong_tenant');
    const selectedSubscription = uuid(subscriptionId, 'subscription_unavailable');
    const token = await azureToken();
    const root = `/subscriptions/${selectedSubscription}`;
    const [subscription, locations] = await Promise.all([
      arm(token, root, '2022-12-01'),
      arm(token, `${root}/locations`, '2022-12-01'),
    ]);
    if (
      uuid(subscription?.subscriptionId, 'subscription_unavailable') !== selectedSubscription ||
      uuid(subscription?.tenantId, 'wrong_tenant') !== selectedTenant ||
      String(subscription?.state || '').toLowerCase() !== 'enabled' ||
      !Array.isArray(locations?.value)
    ) fail('subscription_unavailable');
    return Object.freeze(locations.value
      .filter((entry) => entry?.name && entry?.displayName && entry?.metadata?.regionType !== 'Logical')
      .map((entry) => Object.freeze({ name: String(entry.name), displayName: String(entry.displayName) })));
  }

  async function waitForProvider(token, subscriptionId, namespace) {
    const path = `/subscriptions/${subscriptionId}/providers/${namespace}`;
    await arm(token, `${path}/register`, '2021-04-01', { method: 'POST' });
    for (let attempt = 0; attempt < deploymentAttempts; attempt += 1) {
      const provider = await arm(token, path, '2021-04-01');
      if (String(provider?.registrationState).toLowerCase() === 'registered') return;
      await delay(2_000);
    }
    fail('deployment_failed');
  }

  async function deploy(plan) {
    const token = await azureToken();
    for (const namespace of plan.providerRegistrations || []) {
      await waitForProvider(token, plan.subscription.id, namespace);
    }
    let template;
    try {
      const response = await fetchTemplate(expected.templateUrl, { cache: 'no-store', redirect: 'error' });
      if (!response?.ok) fail('template_invalid');
      template = await response.json();
    } catch (error) {
      if (error instanceof AzureRuntimeError) throw error;
      fail('template_invalid');
    }
    if (template?.$schema?.includes('deploymentTemplate.json') !== true || !template?.resources) {
      fail('template_invalid');
    }
    const deploymentPath = `/subscriptions/${plan.subscription.id}/providers/Microsoft.Resources/deployments/${encodeURIComponent(plan.deployment.name)}`;
    let deployment = await arm(token, deploymentPath, '2025-04-01', {
      method: 'PUT',
      body: JSON.stringify({
        properties: {
          mode: 'Incremental',
          template,
          parameters: parameterValues(plan.deployment.parameters),
        },
      }),
    });
    for (let attempt = 0; attempt < deploymentAttempts; attempt += 1) {
      const state = String(deployment?.properties?.provisioningState || '');
      if (TERMINAL_STATES.has(state)) break;
      await delay(2_000);
      deployment = await arm(token, deploymentPath, '2025-04-01');
    }
    try {
      return verifyRuntimeDeployment({ plan, deployment });
    } catch (error) {
      if (error?.code === 'deployment_mismatch') fail('deployment_mismatch');
      fail('deployment_failed');
    }
  }

  async function graph(token, path, options = {}) {
    return (await jsonResponse(fetchGraph, `${GRAPH}/${path.replace(/^\/+/, '')}`, {
      cache: 'no-store',
      redirect: 'error',
      ...options,
      headers: bearer(token, options.body ? { 'content-type': 'application/json' } : {}),
    }, 'runtime_permissions_failed', 'runtime_permissions_failed')).body;
  }

  async function grantRuntimePermissions({ runtime, tenantApplicationServicePrincipalId }) {
    const principalId = uuid(runtime?.identityPrincipalId, 'runtime_permissions_failed');
    const tenantAppId = uuid(tenantApplicationServicePrincipalId, 'runtime_permissions_failed');
    let token;
    try {
      token = await acquireGraphToken(expected.graphScopes);
    } catch {
      fail('runtime_permissions_failed');
    }
    const graphPrincipals = await graph(token, `servicePrincipals?$filter=appId%20eq%20'00000003-0000-0000-c000-000000000000'&$select=id,appId`);
    if (
      !Array.isArray(graphPrincipals?.value) ||
      graphPrincipals.value.length !== 1 ||
      String(graphPrincipals.value[0]?.appId || '').toLowerCase() !== '00000003-0000-0000-c000-000000000000'
    ) {
      fail('runtime_permissions_failed');
    }
    const graphPrincipalId = uuid(graphPrincipals.value[0].id, 'runtime_permissions_failed');
    const desired = [
      ...Object.entries(RUNTIME_GRAPH_APPLICATION_ROLES).map(([name, appRoleId]) => ({
        name,
        appRoleId,
        resourceId: graphPrincipalId,
      })),
      { name: 'AfterParty.Operate', appRoleId: expected.runtimeApiRoleId, resourceId: tenantAppId },
    ];

    for (let attempt = 0; attempt < propagationAttempts; attempt += 1) {
      try {
        const identity = await graph(token, `servicePrincipals/${principalId}?$select=id,appId,servicePrincipalType`);
        if (
          uuid(identity?.id, 'runtime_permissions_failed') !== principalId ||
          uuid(identity?.appId, 'runtime_permissions_failed') !== uuid(runtime.identityClientId, 'runtime_permissions_failed') ||
          identity?.servicePrincipalType !== 'ManagedIdentity'
        ) {
          fail('runtime_permissions_failed');
        }
        break;
      } catch (error) {
        if (attempt === propagationAttempts - 1) throw error;
        await delay(2_000);
      }
    }

    const assignmentPath = `servicePrincipals/${principalId}/appRoleAssignments`;
    let assignments = await graph(token, `${assignmentPath}?$select=id,principalId,resourceId,appRoleId`);
    if (!Array.isArray(assignments?.value)) fail('runtime_permissions_failed');
    const existing = new Set(assignments.value.map(assignmentKey));
    for (const assignment of desired) {
      if (existing.has(assignmentKey(assignment))) continue;
      await graph(token, assignmentPath, {
        method: 'POST',
        body: JSON.stringify({
          principalId,
          resourceId: assignment.resourceId,
          appRoleId: assignment.appRoleId,
        }),
      });
    }
    for (let attempt = 0; attempt < propagationAttempts; attempt += 1) {
      assignments = await graph(token, `${assignmentPath}?$select=id,principalId,resourceId,appRoleId`);
      const verified = new Set((assignments?.value || []).map(assignmentKey));
      if (desired.every((assignment) => verified.has(assignmentKey(assignment)))) {
        return Object.freeze({
          ...runtime,
          graphApplicationRoles: Object.freeze(Object.keys(RUNTIME_GRAPH_APPLICATION_ROLES)),
          runtimeApiRole: 'AfterParty.Operate',
        });
      }
      await delay(2_000);
    }
    fail('runtime_permissions_failed');
  }

  return Object.freeze({ deploy, grantRuntimePermissions, listLocations, listSubscriptions, preflight });
}
