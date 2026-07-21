import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createRuntimePlan, verifyRuntimeDeployment } from '../runtime/bootstrap.mjs';
import {
  createAzureRuntimeInstaller,
  formatAzureRuntimeError,
  RUNTIME_GRAPH_APPLICATION_ROLES,
} from '../site/azure-runtime.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const subscriptionId = '22222222-2222-2222-2222-222222222222';
const applicationClientId = '33333333-3333-3333-3333-333333333333';
const identityClientId = '55555555-5555-4555-8555-555555555555';
const identityPrincipalId = '66666666-6666-4666-8666-666666666666';
const graphPrincipalId = '77777777-7777-4777-8777-777777777777';
const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const publishedRuntimeTemplate = JSON.parse(await readFile(new URL('../site/runtime-template.json', import.meta.url), 'utf8'));

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function providers(namespace, registrationState = 'Registered') {
  const types = {
    'Microsoft.App': ['managedEnvironments', 'containerApps'],
    'Microsoft.ManagedIdentity': ['userAssignedIdentities'],
    'Microsoft.Storage': ['storageAccounts'],
  };
  return {
    namespace,
    registrationState,
    resourceTypes: types[namespace].map((resourceType) => ({ resourceType, locations: ['East US'] })),
  };
}

function deployment() {
  const resourceGroupId = `/subscriptions/${subscriptionId}/resourceGroups/after-party-runtime`;
  return {
    properties: {
      provisioningState: 'Succeeded',
      outputs: {
        tenantId: { value: tenantId },
        subscriptionId: { value: subscriptionId },
        location: { value: 'eastus' },
        commit: { value: commit },
        resourceGroupId: { value: resourceGroupId },
        apiId: { value: `${resourceGroupId}/providers/Microsoft.App/containerApps/after-party-api` },
        apiUrl: { value: 'https://after-party-api.example.azurecontainerapps.io' },
        authConfigId: { value: `${resourceGroupId}/providers/Microsoft.App/containerApps/after-party-api/authConfigs/current` },
        identityId: { value: `${resourceGroupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/after-party-identity` },
        identityClientId: { value: identityClientId },
        identityPrincipalId: { value: identityPrincipalId },
        ownerRoleAssignmentId: { value: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleAssignments/88888888-8888-4888-8888-888888888888` },
        stateContainerId: { value: `${resourceGroupId}/providers/Microsoft.Storage/storageAccounts/apstate/blobServices/default/containers/state` },
        tenantLockBlobPath: { value: 'locks/tenant-operation.json' },
      },
    },
  };
}

function harness({
  permissions = [{ actions: ['*'], notActions: [] }],
  providerRegistrationState = 'Registered',
  template = publishedRuntimeTemplate,
} = {}) {
  const armCalls = [];
  const graphCalls = [];
  const assignments = [];
  const installer = createAzureRuntimeInstaller({
    configuration: {
      applicationClientId,
      apiImage: `ghcr.io/example/runtime@sha256:${digest}`,
      azureScope: 'https://management.core.windows.net//user_impersonation',
      commit,
      graphScopes: ['AppRoleAssignment.ReadWrite.All'],
      templateUrl: 'https://example.test/runtime-template.json',
    },
    acquireAzureToken: async () => 'arm-token',
    acquireGraphToken: async () => 'graph-token',
    createRuntimePlan,
    verifyRuntimeDeployment,
    delay: async () => {},
    fetchTemplate: async () => response(template),
    async fetchArm(url, options) {
      armCalls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === '/subscriptions') {
        return response({ value: [{ subscriptionId, tenantId, displayName: 'Student Lab', state: 'Enabled' }] });
      }
      if (parsed.pathname === `/subscriptions/${subscriptionId}`) {
        return response({ subscriptionId, tenantId, displayName: 'Student Lab', state: 'Enabled' });
      }
      if (parsed.pathname.endsWith('/locations')) return response({ value: [{ name: 'eastus', displayName: 'East US' }] });
      if (parsed.pathname.endsWith('/Microsoft.Authorization/permissions')) return response({ value: permissions });
      for (const namespace of ['Microsoft.App', 'Microsoft.ManagedIdentity', 'Microsoft.Storage']) {
        if (parsed.pathname.endsWith(`/providers/${namespace}`)) return response(providers(namespace, providerRegistrationState));
      }
      if (parsed.pathname.includes('/deployments/')) return response(deployment());
      throw new Error(`Unexpected ARM URL: ${url}`);
    },
    async fetchGraph(url, options) {
      graphCalls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === '/v1.0/servicePrincipals' && parsed.searchParams.has('$filter')) {
        return response({ value: [{ id: graphPrincipalId, appId: '00000003-0000-0000-c000-000000000000' }] });
      }
      if (parsed.pathname === `/v1.0/servicePrincipals/${identityPrincipalId}`) {
        return response({ id: identityPrincipalId, appId: identityClientId, servicePrincipalType: 'ManagedIdentity' });
      }
      if (parsed.pathname.endsWith(`/${identityPrincipalId}/appRoleAssignments`)) {
        if (options.method === 'POST') {
          const body = JSON.parse(options.body);
          assignments.push({ ...body, id: `${assignments.length}` });
          return response(body, 201);
        }
        return response({ value: assignments });
      }
      throw new Error(`Unexpected Graph URL: ${url}`);
    },
  });
  return { armCalls, assignments, graphCalls, installer };
}

const request = {
  tenantId,
  subscriptionId,
  location: 'eastus',
  resourceGroupName: 'after-party-runtime',
  runtimeName: 'after-party',
};

test('the SPA lists only matching enabled subscriptions and produces a fail-closed plan', async () => {
  const { installer } = harness();
  assert.deepEqual(await installer.listSubscriptions(tenantId), [{
    id: subscriptionId,
    name: 'Student Lab',
    state: 'Enabled',
    tenantId,
  }]);
  const plan = await installer.preflight(request);
  assert.equal(plan.state, 'ready');
  assert.equal(plan.subscription.id, subscriptionId);
  assert.equal(plan.location, 'eastus');
  assert.match(plan.authorization.requiredRole, /Owner/);
});

test('deployment uses the reviewed template and grants every broad runtime role idempotently', async () => {
  const { installer, armCalls, assignments } = harness();
  const plan = await installer.preflight(request);
  const deployed = await installer.deploy(plan);
  const runtime = await installer.grantRuntimePermissions({ runtime: deployed });
  assert.equal(runtime.identityPrincipalId, identityPrincipalId);
  assert.deepEqual(runtime.graphApplicationRoles, Object.keys(RUNTIME_GRAPH_APPLICATION_ROLES));
  assert.equal(Object.hasOwn(runtime, 'runtimeApiRole'), false);
  assert.equal(assignments.length, Object.keys(RUNTIME_GRAPH_APPLICATION_ROLES).length);
  const deploymentPut = armCalls.find((call) => call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(deploymentPut.options.body).properties.template, publishedRuntimeTemplate);

  await installer.grantRuntimePermissions({ runtime });
  assert.equal(assignments.length, Object.keys(RUNTIME_GRAPH_APPLICATION_ROLES).length);
});

test('deployment rejects unsupported templates before provider registration', async () => {
  const { installer, armCalls } = harness({
    providerRegistrationState: 'NotRegistered',
    template: {
      ...publishedRuntimeTemplate,
      $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    },
  });
  const plan = await installer.preflight(request);
  await assert.rejects(installer.deploy(plan), (error) => error.code === 'template_invalid');
  assert.equal(armCalls.some((call) => ['POST', 'PUT'].includes(call.options.method)), false);

  const unsupportedVersion = harness({
    template: {
      ...publishedRuntimeTemplate,
      $schema: 'https://schema.management.azure.com/schemas/9999-99-99/subscriptionDeploymentTemplate.json#',
    },
  });
  const unsupportedPlan = await unsupportedVersion.installer.preflight(request);
  await assert.rejects(unsupportedVersion.installer.deploy(unsupportedPlan), (error) => error.code === 'template_invalid');
});

test('insufficient Azure access fails before any deployment request', async () => {
  const { installer, armCalls } = harness({ permissions: [{ actions: ['*/read'], notActions: [] }] });
  await assert.rejects(installer.preflight(request), (error) => error.code === 'insufficient_role');
  assert.equal(armCalls.some((call) => call.options.method === 'PUT'), false);
});

test('raw cloud failures become fixed guidance', () => {
  assert.equal(
    formatAzureRuntimeError(new Error('secret subscription response')),
    'After Party could not install or verify the tenant runtime.',
  );
});
