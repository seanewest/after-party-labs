import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createRuntimePlan,
  formatRuntimeBootstrapError,
  REQUIRED_CONTROL_PLANE_ACTIONS,
  verifyRuntimeDeployment,
} from '../runtime/bootstrap.mjs';

const tenantId = '11111111-1111-1111-1111-111111111111';
const subscriptionId = '22222222-2222-2222-2222-222222222222';
const applicationClientId = '33333333-3333-3333-3333-333333333333';
const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);

function providers(location = 'East US') {
  return [
    {
      namespace: 'Microsoft.App',
      registrationState: 'Registered',
      resourceTypes: [
        { resourceType: 'managedEnvironments', locations: [location] },
        { resourceType: 'containerApps', locations: [location] },
      ],
    },
    {
      namespace: 'Microsoft.ManagedIdentity',
      registrationState: 'Registered',
      resourceTypes: [{ resourceType: 'userAssignedIdentities', locations: [location] }],
    },
    {
      namespace: 'Microsoft.Storage',
      registrationState: 'Registered',
      resourceTypes: [{ resourceType: 'storageAccounts', locations: [location] }],
    },
  ];
}

function request(overrides = {}) {
  return {
    tenantId,
    subscriptionId,
    applicationClientId,
    location: 'eastus',
    resourceGroupName: 'after-party-runtime',
    runtimeName: 'after-party',
    commit,
    apiImage: `ghcr.io/example/after-party@sha256:${digest}`,
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    subscription: {
      subscriptionId,
      tenantId,
      displayName: 'Student Lab',
      state: 'Enabled',
      ...overrides.subscription,
    },
    locations: overrides.locations ?? [{ name: 'eastus', displayName: 'East US' }],
    providers: overrides.providers ?? providers(),
    permissions: overrides.permissions ?? [{ actions: ['*'], notActions: [] }],
  };
}

function plan() {
  return createRuntimePlan({ request: request(), evidence: evidence() });
}

function deploymentOutputs(overrides = {}) {
  const resourceGroupId = `/subscriptions/${subscriptionId}/resourceGroups/after-party-runtime`;
  return {
    properties: {
      provisioningState: 'Succeeded',
      outputs: {
        tenantId: { type: 'String', value: tenantId },
        subscriptionId: { type: 'String', value: subscriptionId },
        location: { type: 'String', value: 'eastus' },
        commit: { type: 'String', value: commit },
        resourceGroupId: { type: 'String', value: resourceGroupId },
        apiId: {
          type: 'String',
          value: `${resourceGroupId}/providers/Microsoft.App/containerApps/after-party-api`,
        },
        apiUrl: {
          type: 'String',
          value: 'https://after-party-api.example.eastus.azurecontainerapps.io',
        },
        authConfigId: {
          type: 'String',
          value: `${resourceGroupId}/providers/Microsoft.App/containerApps/after-party-api/authConfigs/current`,
        },
        identityId: {
          type: 'String',
          value: `${resourceGroupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/after-party-identity`,
        },
        stateContainerId: {
          type: 'String',
          value: `${resourceGroupId}/providers/Microsoft.Storage/storageAccounts/apstate/blobServices/default/containers/state`,
        },
        ...overrides,
      },
    },
  };
}

test('a verified selection produces one deterministic install-or-repair plan', () => {
  const first = plan();
  const second = plan();

  assert.deepEqual(first, second);
  assert.equal(first.state, 'ready');
  assert.equal(first.subscription.name, 'Student Lab');
  assert.equal(first.location, 'eastus');
  assert.equal(first.deployment.name, `after-party-${commit.slice(0, 12)}`);
  assert.equal(first.deployment.scope, `/subscriptions/${subscriptionId}`);
  assert.equal(first.deployment.templateFile, 'infra/main.bicep');
  assert.equal(first.deployment.mode, 'Incremental');
  assert.equal(first.deployment.parameters.apiImage.endsWith(digest), true);
  assert.equal(first.authorization.verified, true);
  assert.deepEqual(first.providerRegistrations, []);
  assert.match(first.authorization.requiredRole, /Contributor.*Role Based Access Control/i);
});

test('Contributor and RBAC Administrator capabilities combine without requiring Owner', () => {
  const contributor = {
    actions: ['*'],
    notActions: [
      'Microsoft.Authorization/*/Delete',
      'Microsoft.Authorization/*/Write',
    ],
  };
  const rbacAdministrator = {
    actions: ['*/read', 'Microsoft.Authorization/roleAssignments/write'],
    notActions: [],
  };

  const result = createRuntimePlan({
    request: request(),
    evidence: evidence({ permissions: [contributor, rbacAdministrator] }),
  });

  assert.equal(result.authorization.verified, true);
  assert.ok(REQUIRED_CONTROL_PLANE_ACTIONS.includes('Microsoft.Authorization/roleAssignments/write'));
});

test('subscription and tenant mismatches fail before a plan exists', () => {
  assert.throws(
    () =>
      createRuntimePlan({
        request: request(),
        evidence: evidence({
          subscription: { subscriptionId: '33333333-3333-3333-3333-333333333333' },
        }),
      }),
    (error) => error.code === 'wrong_subscription',
  );
  assert.throws(
    () =>
      createRuntimePlan({
        request: request(),
        evidence: evidence({
          subscription: { tenantId: '44444444-4444-4444-4444-444444444444' },
        }),
      }),
    (error) => error.code === 'wrong_tenant',
  );
});

test('unavailable or unsupported regions and providers fail closed', () => {
  const cases = [
    { evidence: evidence({ locations: [] }), code: 'region_unavailable' },
    { evidence: evidence({ providers: providers('West US') }), code: 'region_unsupported' },
    { evidence: evidence({ providers: providers().slice(1) }), code: 'provider_unavailable' },
  ];

  for (const entry of cases) {
    assert.throws(
      () => createRuntimePlan({ request: request(), evidence: entry.evidence }),
      (error) => error.code === entry.code,
    );
  }
});

test('unregistered providers become an explicit idempotent installation step', () => {
  const result = createRuntimePlan({
    request: request(),
    evidence: evidence({
      providers: providers().map((provider, index) =>
        index === 0 ? { ...provider, registrationState: 'NotRegistered' } : provider,
      ),
    }),
  });

  assert.deepEqual(result.providerRegistrations, ['Microsoft.App']);
  assert.match(result.resources[0], /provider registrations/i);
  assert.ok(REQUIRED_CONTROL_PLANE_ACTIONS.includes('Microsoft.App/register/action'));
});

test('missing deployment or role-assignment capability fails before mutation', () => {
  const readOnly = [{ actions: ['*/read'], notActions: [] }];
  assert.throws(
    () =>
      createRuntimePlan({
        request: request(),
        evidence: evidence({ permissions: readOnly }),
      }),
    (error) => {
      assert.match(formatRuntimeBootstrapError(error), /Owner|Contributor/i);
      return error.code === 'insufficient_role';
    },
  );
});

test('missing runtime attachment or authentication capability fails before mutation', () => {
  for (const missingAction of [
    'Microsoft.App/managedEnvironments/join/action',
    'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action',
    'Microsoft.App/containerApps/authConfigs/read',
    'Microsoft.App/containerApps/authConfigs/write',
  ]) {
    const customRole = [
      {
        actions: REQUIRED_CONTROL_PLANE_ACTIONS.filter((action) => action !== missingAction),
        notActions: [],
      },
    ];

    assert.throws(
      () =>
        createRuntimePlan({
          request: request(),
          evidence: evidence({ permissions: customRole }),
        }),
      (error) => error.code === 'insufficient_role',
      missingAction,
    );
  }
});

test('plans require a full commit and digest-pinned public image', () => {
  for (const [field, value, code] of [
    ['commit', 'abc123', 'commit_invalid'],
    ['apiImage', 'ghcr.io/example/after-party:latest', 'image_invalid'],
  ]) {
    assert.throws(
      () =>
        createRuntimePlan({
          request: request({ [field]: value }),
          evidence: evidence(),
        }),
      (error) => error.code === code,
    );
  }
});

test('resource group casing cannot create a second storage identity', () => {
  const result = createRuntimePlan({
    request: request({ resourceGroupName: 'AFTER-PARTY-RUNTIME' }),
    evidence: evidence(),
  });

  assert.equal(result.deployment.parameters.resourceGroupName, 'after-party-runtime');
});

test('a complete deployment is verified against the exact plan identity', () => {
  const result = verifyRuntimeDeployment({ plan: plan(), deployment: deploymentOutputs() });

  assert.equal(result.state, 'verified');
  assert.equal(result.tenantId, tenantId);
  assert.equal(result.subscriptionId, subscriptionId);
  assert.equal(result.subscriptionName, 'Student Lab');
  assert.equal(result.commit, commit);
  assert.match(result.authConfigId, /authConfigs\/current$/);
  assert.match(result.apiUrl, /^https:/);
  assert.equal(Object.hasOwn(result, 'token'), false);
});

test('failed, partial, or mismatched deployments never report verified', () => {
  assert.throws(
    () =>
      verifyRuntimeDeployment({
        plan: plan(),
        deployment: { properties: { provisioningState: 'Failed' } },
      }),
    (error) => error.code === 'deployment_failed',
  );
  assert.throws(
    () =>
      verifyRuntimeDeployment({
        plan: plan(),
        deployment: deploymentOutputs({ apiUrl: undefined }),
      }),
    (error) => error.code === 'partial_deployment',
  );
  assert.throws(
    () =>
      verifyRuntimeDeployment({
        plan: plan(),
        deployment: deploymentOutputs({ commit: { type: 'String', value: 'c'.repeat(40) } }),
      }),
    (error) => error.code === 'deployment_mismatch',
  );
  assert.throws(
    () =>
      verifyRuntimeDeployment({
        plan: plan(),
        deployment: deploymentOutputs({
          stateContainerId: {
            type: 'String',
            value: `/subscriptions/${subscriptionId}/resourceGroups/after-party-runtime/providers/Microsoft.Storage/storageAccounts/apstate/unexpected/path/blobServices/default/containers/state`,
          },
        }),
      }),
    (error) => error.code === 'deployment_mismatch',
  );
});

test('the Bicep runtime is minimal, passwordless, stateful, and versioned', async () => {
  const main = await readFile(new URL('../infra/main.bicep', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('../infra/runtime.bicep', import.meta.url), 'utf8');
  const source = `${main}\n${runtime}`;

  for (const resourceType of [
    'Microsoft.Resources/resourceGroups',
    'Microsoft.App/managedEnvironments',
    'Microsoft.App/containerApps',
    'Microsoft.App/containerApps/authConfigs',
    'Microsoft.ManagedIdentity/userAssignedIdentities',
    'Microsoft.Storage/storageAccounts',
    'Microsoft.Authorization/roleAssignments',
  ]) {
    assert.match(source, new RegExp(resourceType.replaceAll('.', '\\.')));
  }
  assert.match(runtime, /allowSharedKeyAccess: false/);
  assert.match(runtime, /allowBlobPublicAccess: false/);
  assert.match(runtime, /Storage\/storageAccounts\/blobServices\/containers/);
  assert.match(runtime, /after-party-commit/);
  assert.match(runtime, /apiImage/);
  assert.match(runtime, /unauthenticatedClientAction: 'Return401'/);
  assert.match(runtime, /allowedApplications/);
  assert.match(runtime, /AFTER_PARTY_API_SCOPE/);
  assert.doesNotMatch(source, /Microsoft\.App\/jobs/i);
  assert.doesNotMatch(source, /clientSecret|listKeys|accountKey/i);
});
