import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExperimentCardController,
  defineExperimentCard,
  describeExperimentCard,
  mountExperimentCard,
} from '../site/experiments.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.hidden = false;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }
}

function exampleCard(overrides = {}) {
  return defineExperimentCard({
    id: 'runtime-status',
    title: 'Check tenant runtime',
    description: 'Read the installed runtime version without changing the tenant.',
    requirement: { kind: 'permission', label: 'Runtime.Status.Read' },
    effect: 'read',
    availability: true,
    actionLabel: 'Check runtime',
    action: async () => ({
      summary: 'The tenant runtime is ready.',
      tenantId: '22222222-2222-2222-2222-222222222222',
      version: 'abc123',
    }),
    errorGuidance: 'Reconnect the tenant and try again.',
    ...overrides,
  });
}

test('experiment definitions require the shared identity, access, effect, action, and guidance contract', () => {
  const card = exampleCard();

  assert.equal(card.id, 'runtime-status');
  assert.deepEqual(card.requirement, { kind: 'permission', label: 'Runtime.Status.Read' });
  assert.equal(card.effect, 'read');
  assert.equal(Object.isFrozen(card), true);
  assert.throws(() => exampleCard({ id: 'Runtime Status' }), /lowercase kebab-case/);
  assert.throws(() => exampleCard({ requirement: undefined }), /permission or role/);
  assert.throws(() => exampleCard({ effect: 'unknown' }), /read or write/);
  assert.throws(() => exampleCard({ action: undefined }), /must be a function/);
  assert.throws(() => exampleCard({ errorGuidance: '' }), /non-empty string/);
});

test('experiment view models explain read and write effects before an action runs', () => {
  const readModel = describeExperimentCard(exampleCard(), { status: 'idle' });
  const writeModel = describeExperimentCard(
    exampleCard({
      id: 'runtime-install',
      effect: 'write',
      requirement: { kind: 'role', label: 'Global Administrator' },
    }),
    { status: 'idle' },
  );

  assert.equal(readModel.effectLabel, 'Reads tenant data');
  assert.equal(readModel.requirement, 'Permission: Runtime.Status.Read');
  assert.match(readModel.statusMessage, /Review the effect and requirement/);
  assert.equal(writeModel.effectLabel, 'Changes tenant data');
  assert.equal(writeModel.requirement, 'Role: Global Administrator');
});

test('experiment controllers publish pending and success with tenant and deployed version results', async () => {
  let resolveAction;
  const renders = [];
  const card = exampleCard({
    action: () =>
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
  });
  const controller = createExperimentCardController({
    card,
    render: (model) => renders.push(model),
  });

  assert.equal(controller.getState().status, 'idle');
  const operation = controller.run();
  assert.equal(controller.getState().status, 'pending');
  assert.equal(renders.at(-1).actionDisabled, true);
  resolveAction({
    summary: 'Installed and verified.',
    tenantId: '22222222-2222-2222-2222-222222222222',
    version: 'deploy-7',
    details: [{ label: 'Region', value: 'eastus' }],
  });
  await operation;

  const success = renders.at(-1);
  assert.equal(success.status, 'success');
  assert.equal(success.statusMessage, 'Installed and verified.');
  assert.deepEqual(success.metadata, [
    { label: 'Tenant ID', value: '22222222-2222-2222-2222-222222222222' },
    { label: 'Deployed version', value: 'deploy-7' },
    { label: 'Region', value: 'eastus' },
  ]);
});

test('blocked experiments explain availability without invoking the action', async () => {
  let actionCalls = 0;
  const renders = [];
  const card = exampleCard({
    availability: { available: false, reason: 'Install the tenant runtime first.' },
    action: async () => {
      actionCalls += 1;
      return { summary: 'Unexpected.' };
    },
  });
  const controller = createExperimentCardController({
    card,
    render: (model) => renders.push(model),
  });

  await controller.run();

  assert.equal(actionCalls, 0);
  assert.equal(controller.getState().status, 'blocked');
  assert.equal(renders.at(-1).statusMessage, 'Install the tenant runtime first.');
  assert.equal(renders.at(-1).guidance, 'Reconnect the tenant and try again.');
  assert.equal(renders.at(-1).actionDisabled, true);
});

test('failed experiments render concise errors and recovery guidance', async () => {
  const renders = [];
  const controller = createExperimentCardController({
    card: exampleCard({
      action: async () => {
        throw new Error('Runtime verification timed out.');
      },
    }),
    render: (model) => renders.push(model),
  });

  await controller.run();

  assert.equal(controller.getState().status, 'failure');
  assert.equal(renders.at(-1).statusMessage, 'Runtime verification timed out.');
  assert.equal(renders.at(-1).guidance, 'Reconnect the tenant and try again.');
  assert.equal(renders.at(-1).actionDisabled, false);
});

test('malformed operation results fail closed as a rendered failure', async () => {
  const renders = [];
  const controller = createExperimentCardController({
    card: exampleCard({ action: async () => ({ tenantId: 'missing-summary' }) }),
    render: (model) => renders.push(model),
  });

  await controller.run();

  assert.equal(controller.getState().status, 'failure');
  assert.match(renders.at(-1).statusMessage, /summary must be a non-empty string/);
});

test('the shared DOM presentation renders state and result metadata below its action', async () => {
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  const container = new FakeElement('div');
  const controller = mountExperimentCard({
    document,
    container,
    card: exampleCard(),
  });

  const article = container.children[0];
  const status = article.children.find((child) => child.className === 'experiment-status notice');
  const metadata = article.children.find((child) => child.className === 'experiment-result');
  const action = article.children.find((child) => child.className.includes('experiment-action'));

  assert.equal(article.dataset.state, 'idle');
  assert.equal(status.children[0].textContent, 'Ready');
  assert.equal(action.disabled, false);
  assert.equal(article.children.indexOf(action) < article.children.indexOf(status), true);
  assert.equal(article.children.indexOf(status) < article.children.indexOf(metadata), true);
  await action.listeners.click();

  assert.equal(controller.getState().status, 'success');
  assert.equal(article.dataset.state, 'success');
  assert.equal(status.children[0].textContent, 'Succeeded');
  assert.equal(metadata.hidden, false);
  assert.deepEqual(
    metadata.children.map((child) => child.textContent),
    [
      'Tenant ID',
      '22222222-2222-2222-2222-222222222222',
      'Deployed version',
      'abc123',
    ],
  );
});
