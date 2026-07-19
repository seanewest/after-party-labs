const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const IMAGE_DIGEST_PATTERN = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/i;
const RESOURCE_GROUP_PATTERN = /^[A-Za-z0-9._()\-]{1,90}$/;
const RUNTIME_NAME_PATTERN = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;

export const RUNTIME_TEMPLATE_FILE = 'infra/main.bicep';
export const REQUIRED_AZURE_ROLE_SUMMARY =
  'Owner, or Contributor plus Role Based Access Control Administrator, at the selected subscription';

export const REQUIRED_CONTROL_PLANE_ACTIONS = Object.freeze([
  'Microsoft.Resources/subscriptions/read',
  'Microsoft.Resources/subscriptions/locations/read',
  'Microsoft.Resources/subscriptions/providers/read',
  'Microsoft.Resources/subscriptions/resourceGroups/read',
  'Microsoft.Resources/subscriptions/resourceGroups/write',
  'Microsoft.Resources/deployments/read',
  'Microsoft.Resources/deployments/write',
  'Microsoft.Resources/deployments/validate/action',
  'Microsoft.Resources/deployments/whatIf/action',
  'Microsoft.Resources/deployments/operations/read',
  'Microsoft.Resources/deployments/operationStatuses/read',
  'Microsoft.App/register/action',
  'Microsoft.App/managedEnvironments/read',
  'Microsoft.App/managedEnvironments/write',
  'Microsoft.App/containerApps/read',
  'Microsoft.App/containerApps/write',
  'Microsoft.ManagedIdentity/userAssignedIdentities/read',
  'Microsoft.ManagedIdentity/userAssignedIdentities/write',
  'Microsoft.ManagedIdentity/register/action',
  'Microsoft.Storage/storageAccounts/read',
  'Microsoft.Storage/storageAccounts/write',
  'Microsoft.Storage/storageAccounts/blobServices/containers/read',
  'Microsoft.Storage/storageAccounts/blobServices/containers/write',
  'Microsoft.Storage/register/action',
  'Microsoft.Authorization/roleAssignments/read',
  'Microsoft.Authorization/roleAssignments/write',
  'Microsoft.Authorization/roleDefinitions/read',
  'Microsoft.Authorization/permissions/read',
]);

const REQUIRED_LOCATION_RESOURCES = Object.freeze([
  ['Microsoft.App', 'managedEnvironments'],
  ['Microsoft.App', 'containerApps'],
  ['Microsoft.ManagedIdentity', 'userAssignedIdentities'],
  ['Microsoft.Storage', 'storageAccounts'],
]);

export class RuntimeBootstrapError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireUuid(value, code) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new RuntimeBootstrapError(code);
  }
  return normalized;
}

function requireCommit(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!COMMIT_PATTERN.test(normalized)) {
    throw new RuntimeBootstrapError('commit_invalid');
  }
  return normalized;
}

function requireImageDigest(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!IMAGE_DIGEST_PATTERN.test(normalized)) {
    throw new RuntimeBootstrapError('image_invalid');
  }
  return normalized;
}

function requireResourceGroupName(value) {
  const normalized = String(value || '').trim();
  if (!RESOURCE_GROUP_PATTERN.test(normalized) || normalized.endsWith('.')) {
    throw new RuntimeBootstrapError('resource_group_invalid');
  }
  return normalized.toLowerCase();
}

function requireRuntimeName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!RUNTIME_NAME_PATTERN.test(normalized)) {
    throw new RuntimeBootstrapError('runtime_name_invalid');
  }
  return normalized;
}

function locationKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function requireLocation(requestedLocation, locations) {
  const requestedKey = locationKey(requestedLocation);
  const match = (Array.isArray(locations) ? locations : []).find(
    (location) =>
      locationKey(location?.name) === requestedKey ||
      locationKey(location?.displayName) === requestedKey,
  );
  if (!requestedKey || !match?.name) {
    throw new RuntimeBootstrapError('region_unavailable');
  }
  return String(match.name).toLowerCase();
}

function providerFor(providers, namespace) {
  return (Array.isArray(providers) ? providers : []).find(
    (provider) => provider?.namespace?.toLowerCase() === namespace.toLowerCase(),
  );
}

function validateProviderLocations(providers, location) {
  const registrations = new Set();
  for (const [namespace, resourceType] of REQUIRED_LOCATION_RESOURCES) {
    const provider = providerFor(providers, namespace);
    const registrationState = provider?.registrationState?.toLowerCase();
    if (
      !['registered', 'registering', 'notregistered', 'unregistered'].includes(
        registrationState,
      )
    ) {
      throw new RuntimeBootstrapError('provider_unavailable');
    }
    if (registrationState !== 'registered') {
      registrations.add(namespace);
    }
    const type = (Array.isArray(provider.resourceTypes) ? provider.resourceTypes : []).find(
      (candidate) => candidate?.resourceType?.toLowerCase() === resourceType.toLowerCase(),
    );
    if (
      !type ||
      !(Array.isArray(type.locations) ? type.locations : []).some(
        (candidate) => locationKey(candidate) === locationKey(location),
      )
    ) {
      throw new RuntimeBootstrapError('region_unsupported');
    }
  }
  return [...registrations];
}

function wildcardPattern(value) {
  const escaped = String(value || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`, 'i');
}

function actionMatches(pattern, action) {
  return wildcardPattern(pattern).test(action);
}

function permissionAllows(permission, action) {
  const actions = Array.isArray(permission?.actions) ? permission.actions : [];
  const notActions = Array.isArray(permission?.notActions) ? permission.notActions : [];
  return (
    actions.some((pattern) => actionMatches(pattern, action)) &&
    !notActions.some((pattern) => actionMatches(pattern, action))
  );
}

function missingActions(permissions) {
  const entries = Array.isArray(permissions) ? permissions : [];
  return REQUIRED_CONTROL_PLANE_ACTIONS.filter(
    (action) => !entries.some((permission) => permissionAllows(permission, action)),
  );
}

function deploymentName(runtimeName, commit) {
  return `${runtimeName}-${commit.slice(0, 12)}`;
}

export function formatRuntimeBootstrapError(error) {
  const messages = {
    request_invalid: 'The runtime installation request is incomplete.',
    subscription_unavailable: 'The selected Azure subscription is not accessible and enabled.',
    wrong_subscription: 'Azure returned a different subscription. Select the intended subscription again.',
    wrong_tenant: 'The selected Azure subscription belongs to a different tenant.',
    region_unavailable: 'Choose an Azure region available to this subscription.',
    provider_unavailable: 'Azure could not confirm a required resource provider for this subscription.',
    region_unsupported: 'The selected region does not support every required After Party resource.',
    insufficient_role: `The signed-in operator needs ${REQUIRED_AZURE_ROLE_SUMMARY}.`,
    commit_invalid: 'The runtime must be tied to one full Git commit.',
    image_invalid: 'The runtime image must be pinned to a SHA-256 digest.',
    resource_group_invalid: 'Choose a valid Azure resource group name.',
    runtime_name_invalid: 'Choose a short lowercase runtime name.',
    deployment_failed: 'Azure did not complete the runtime deployment successfully.',
    deployment_mismatch: 'The deployed runtime does not match the selected tenant, subscription, region, or commit.',
    partial_deployment: 'Azure returned an incomplete runtime deployment. Run install or repair again.',
  };
  return messages[error?.code] || 'After Party could not plan or verify the tenant runtime.';
}

export function createRuntimePlan({ request, evidence }) {
  if (!request || !evidence?.subscription) {
    throw new RuntimeBootstrapError('request_invalid');
  }

  const tenantId = requireUuid(request.tenantId, 'request_invalid');
  const subscriptionId = requireUuid(request.subscriptionId, 'request_invalid');
  const actualSubscriptionId = requireUuid(
    evidence.subscription.subscriptionId,
    'subscription_unavailable',
  );
  const actualTenantId = requireUuid(
    evidence.subscription.tenantId,
    'subscription_unavailable',
  );
  if (actualSubscriptionId !== subscriptionId) {
    throw new RuntimeBootstrapError('wrong_subscription');
  }
  if (actualTenantId !== tenantId) {
    throw new RuntimeBootstrapError('wrong_tenant');
  }
  if (String(evidence.subscription.state || '').toLowerCase() !== 'enabled') {
    throw new RuntimeBootstrapError('subscription_unavailable');
  }

  const location = requireLocation(request.location, evidence.locations);
  const providerRegistrations = validateProviderLocations(evidence.providers, location);
  const missingControlPlaneActions = missingActions(evidence.permissions);
  if (missingControlPlaneActions.length) {
    throw new RuntimeBootstrapError('insufficient_role');
  }

  const commit = requireCommit(request.commit);
  const image = requireImageDigest(request.apiImage);
  const resourceGroupName = requireResourceGroupName(request.resourceGroupName);
  const runtimeName = requireRuntimeName(request.runtimeName);
  const subscriptionName = String(evidence.subscription.displayName || '').trim();
  if (!subscriptionName) {
    throw new RuntimeBootstrapError('subscription_unavailable');
  }

  return Object.freeze({
    schemaVersion: 1,
    operation: 'install-or-repair',
    state: 'ready',
    tenant: Object.freeze({ id: tenantId }),
    subscription: Object.freeze({ id: subscriptionId, name: subscriptionName }),
    location,
    authorization: Object.freeze({
      requiredRole: REQUIRED_AZURE_ROLE_SUMMARY,
      verified: true,
    }),
    providerRegistrations: Object.freeze(providerRegistrations),
    deployment: Object.freeze({
      name: deploymentName(runtimeName, commit),
      scope: `/subscriptions/${subscriptionId}`,
      templateFile: RUNTIME_TEMPLATE_FILE,
      mode: 'Incremental',
      parameters: Object.freeze({
        expectedTenantId: tenantId,
        expectedSubscriptionId: subscriptionId,
        location,
        resourceGroupName,
        runtimeName,
        commit,
        apiImage: image,
      }),
    }),
    resources: Object.freeze([
      ...(providerRegistrations.length ? ['required Azure resource-provider registrations'] : []),
      'resource group',
      'Container Apps environment',
      'Container App API',
      'user-assigned managed identity',
      'StorageV2 account and private state container',
      'container-scoped Storage Blob Data Contributor assignment',
    ]),
  });
}

function outputValue(outputs, name) {
  const output = outputs?.[name];
  if (!output || typeof output.value !== 'string' || !output.value.trim()) {
    throw new RuntimeBootstrapError('partial_deployment');
  }
  return output.value.trim();
}

export function verifyRuntimeDeployment({ plan, deployment }) {
  if (plan?.state !== 'ready' || plan?.schemaVersion !== 1) {
    throw new RuntimeBootstrapError('request_invalid');
  }
  if (deployment?.properties?.provisioningState !== 'Succeeded') {
    throw new RuntimeBootstrapError('deployment_failed');
  }

  const outputs = deployment.properties.outputs;
  const tenantId = requireUuid(outputValue(outputs, 'tenantId'), 'deployment_mismatch');
  const subscriptionId = requireUuid(
    outputValue(outputs, 'subscriptionId'),
    'deployment_mismatch',
  );
  const location = outputValue(outputs, 'location').toLowerCase();
  const commit = requireCommit(outputValue(outputs, 'commit'));
  if (
    tenantId !== plan.tenant.id ||
    subscriptionId !== plan.subscription.id ||
    locationKey(location) !== locationKey(plan.location) ||
    commit !== plan.deployment.parameters.commit
  ) {
    throw new RuntimeBootstrapError('deployment_mismatch');
  }

  const resourceGroupId = outputValue(outputs, 'resourceGroupId');
  const apiId = outputValue(outputs, 'apiId');
  const apiUrl = outputValue(outputs, 'apiUrl');
  const identityId = outputValue(outputs, 'identityId');
  const stateContainerId = outputValue(outputs, 'stateContainerId');
  const expectedResourceGroupId =
    `/subscriptions/${subscriptionId}/resourceGroups/${plan.deployment.parameters.resourceGroupName}`;
  const expectedApiId =
    `${expectedResourceGroupId}/providers/Microsoft.App/containerApps/${plan.deployment.parameters.runtimeName}-api`;
  const expectedIdentityId =
    `${expectedResourceGroupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${plan.deployment.parameters.runtimeName}-identity`;
  const stateContainerPrefix =
    `${expectedResourceGroupId}/providers/Microsoft.Storage/storageAccounts/`.toLowerCase();
  const normalizedStateContainerId = stateContainerId.toLowerCase();
  const stateContainerPath = normalizedStateContainerId.startsWith(stateContainerPrefix)
    ? normalizedStateContainerId.slice(stateContainerPrefix.length).split('/')
    : [];
  if (
    resourceGroupId.toLowerCase() !== expectedResourceGroupId.toLowerCase() ||
    apiId.toLowerCase() !== expectedApiId.toLowerCase() ||
    identityId.toLowerCase() !== expectedIdentityId.toLowerCase() ||
    stateContainerPath.length !== 5 ||
    !/^[a-z0-9]{3,24}$/.test(stateContainerPath[0]) ||
    stateContainerPath.slice(1).join('/') !== 'blobservices/default/containers/state' ||
    !/^https:\/\/[a-z0-9.-]+\.azurecontainerapps\.io$/i.test(apiUrl)
  ) {
    throw new RuntimeBootstrapError('deployment_mismatch');
  }

  return Object.freeze({
    schemaVersion: 1,
    state: 'verified',
    tenantId,
    subscriptionId,
    subscriptionName: plan.subscription.name,
    location: plan.location,
    commit,
    resourceGroupId,
    apiId,
    apiUrl,
    identityId,
    stateContainerId,
  });
}
