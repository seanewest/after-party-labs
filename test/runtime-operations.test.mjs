import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeOperationExecutor } from '../runtime/operations.mjs';
import { createTenantOperationLock } from '../runtime/tenant-lock.mjs';

const tenantId = '11111111-1111-1111-1111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const commit = 'a'.repeat(40);

class MemoryLeaseStore {
  entry;

  async acquire({ leaseId, record }) {
    if (this.entry) return { acquired: false, record: this.entry.record };
    this.entry = { leaseId, record };
    return { acquired: true };
  }

  async renew({ leaseId, record }) {
    if (this.entry?.leaseId !== leaseId) return { renewed: false };
    this.entry.record = record;
    return { renewed: true };
  }

  async release({ leaseId }) {
    if (this.entry?.leaseId !== leaseId) return { released: false };
    this.entry = undefined;
    return { released: true };
  }
}

function uuidSource() {
  let value = 3;
  return () => `${String(value++).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function authorized(operation, overrides = {}) {
  return {
    status: 'authorized',
    callerClass: 'delegated-operator',
    operation,
    requestId,
    tenantId,
    runtimeId: `/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/after-party-runtime/providers/Microsoft.App/containerApps/after-party-api`,
    commit,
    ...overrides,
  };
}

test('the deployed lock operation proves ownership, contention, release, and recovery', async () => {
  const randomUUID = uuidSource();
  const store = new MemoryLeaseStore();
  const lock = createTenantOperationLock({ store, randomUUID });
  const executor = createRuntimeOperationExecutor({ lock, randomUUID });

  const result = await executor.run(authorized('lock.test'));

  assert.deepEqual(result.diagnostic, {
    state: 'contention-confirmed',
    owner: 'exclusive',
    competitor: 'blocked',
    recovery: 'released',
  });
  assert.equal(store.entry, undefined);
});

test('runtime status is read-only and unknown operations fail closed', async () => {
  const randomUUID = uuidSource();
  const executor = createRuntimeOperationExecutor({
    lock: createTenantOperationLock({ store: new MemoryLeaseStore(), randomUUID }),
    randomUUID,
  });
  const status = authorized('runtime.status');
  assert.equal(await executor.run(status), status);
  await assert.rejects(
    executor.run(authorized('tenant.erase')),
    (error) => error.code === 'operation_not_allowed',
  );
});
