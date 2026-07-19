import assert from 'node:assert/strict';
import test from 'node:test';

import { createExperimentCardController } from '../site/experiments.js';
import { createRuntimeCardsController } from '../site/runtime-cards.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const subscriptionId = '22222222-2222-2222-2222-222222222222';
const servicePrincipalId = '33333333-3333-4333-8333-333333333333';
const identityClientId = '44444444-4444-4444-8444-444444444444';
const commit = 'a'.repeat(40);

function runtime() {
  return {
    state: 'verified',
    tenantId,
    subscriptionId,
    subscriptionName: 'Student Lab',
    location: 'eastus',
    commit,
    apiId: `/subscriptions/${subscriptionId}/resourceGroups/after-party-runtime/providers/Microsoft.App/containerApps/after-party-api`,
    apiUrl: 'https://after-party-api.example.azurecontainerapps.io',
    identityClientId,
    identityPrincipalId: '55555555-5555-4555-8555-555555555555',
  };
}

function plan() {
  return {
    state: 'ready',
    tenant: { id: tenantId },
    subscription: { id: subscriptionId, name: 'Student Lab' },
    location: 'eastus',
    authorization: { requiredRole: 'Owner', verified: true },
    deployment: { parameters: { commit } },
    resources: ['resource group', 'broad runtime identity'],
  };
}

function harness({ preflightError } = {}) {
  const events = [];
  const rendered = new Map();
  const calls = { deploy: 0, grant: 0, lock: 0 };
  let cards;
  const controller = createRuntimeCardsController({
    installer: {
      async listSubscriptions(selectedTenantId) {
        assert.equal(selectedTenantId, tenantId);
        return [{ id: subscriptionId, name: 'Student Lab' }];
      },
      async listLocations(selection) {
        assert.deepEqual(selection, { tenantId, subscriptionId });
        return [{ name: 'eastus', displayName: 'East US' }];
      },
      async preflight(selection) {
        assert.deepEqual(selection, {
          tenantId,
          subscriptionId,
          location: 'eastus',
          resourceGroupName: 'after-party-runtime',
          runtimeName: 'after-party',
        });
        if (preflightError) throw { code: preflightError };
        return plan();
      },
      async deploy(value) {
        calls.deploy += 1;
        assert.equal(value, planValue());
        return runtime();
      },
      async grantRuntimePermissions(input) {
        calls.grant += 1;
        assert.deepEqual(Object.keys(input), ['runtime']);
        return input.runtime;
      },
    },
    runtimeApiFactory(value) {
      assert.equal(value.tenantId, tenantId);
      return {
        async run(operation) {
          calls.lock += 1;
          assert.equal(operation, 'lock.test');
          return {
            tenantId,
            commit,
            diagnostic: {
              state: 'contention-confirmed',
              owner: 'exclusive',
              competitor: 'blocked',
              recovery: 'released',
            },
          };
        },
      };
    },
    mountCards(values) {
      cards = values;
      return values.map((card) => createExperimentCardController({
        card,
        render: (model) => rendered.set(card.id, model),
      }));
    },
    view: {
      elements: { verify: { disabled: false } },
      show: () => events.push(['show']),
      hide: () => events.push(['hide']),
      pending: (message) => events.push(['pending', message]),
      error: (message) => events.push(['error', message]),
      subscriptions: (values) => events.push(['subscriptions', values]),
      locations: (values) => events.push(['locations', values]),
      plan: (value) => events.push(['plan', value]),
    },
  });

  function planValue() {
    return controller.getState().plan;
  }

  return { calls, cards: () => cards, controller, events, rendered };
}

test('runtime cards stay blocked until the exact verified target is confirmed', async () => {
  const { calls, cards, controller, rendered } = harness();
  assert.deepEqual(cards().map((card) => card.id), [
    'install-tenant-runtime',
    'test-tenant-lock',
  ]);
  assert.equal(rendered.get('install-tenant-runtime').status, 'blocked');

  await controller.connect({ tenantId, servicePrincipalId });
  assert.equal(rendered.get('install-tenant-runtime').status, 'blocked');
  await controller.verifySelection({ subscriptionId, location: 'eastus' });
  assert.equal(controller.getState().plan.authorization.verified, true);
  assert.equal(rendered.get('install-tenant-runtime').status, 'blocked');

  controller.confirm(true);
  assert.equal(rendered.get('install-tenant-runtime').status, 'idle');
  await controller.getState().controllers[0].run();
  assert.equal(calls.deploy, 1);
  assert.equal(calls.grant, 1);
  assert.equal(rendered.get('install-tenant-runtime').status, 'success');
  assert.equal(rendered.get('install-tenant-runtime').metadata[0].value, tenantId);
  assert.equal(rendered.get('install-tenant-runtime').metadata[1].value, commit);
  assert.equal(rendered.get('test-tenant-lock').status, 'idle');

  await controller.getState().controllers[1].run();
  assert.equal(calls.lock, 1);
  assert.equal(rendered.get('test-tenant-lock').status, 'success');
  assert.match(rendered.get('test-tenant-lock').statusMessage, /blocked its competitor/i);

  controller.changeLocation();
  assert.equal(controller.getState().plan, null);
  assert.equal(rendered.get('install-tenant-runtime').status, 'blocked');
  assert.equal(rendered.get('test-tenant-lock').status, 'blocked');
});

test('an insufficient role fails preflight before deployment', async () => {
  const { calls, controller, events, rendered } = harness({ preflightError: 'insufficient_role' });
  await controller.connect({ tenantId, servicePrincipalId });
  await controller.verifySelection({ subscriptionId, location: 'eastus' });

  assert.equal(calls.deploy, 0);
  assert.equal(controller.getState().plan, null);
  assert.equal(rendered.get('install-tenant-runtime').status, 'blocked');
  assert.match(events.at(-1)[1], /required Azure role/i);
});
