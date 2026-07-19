import assert from 'node:assert/strict';
import test from 'node:test';

import { createBlobLeaseStore } from '../runtime/blob-lease-store.mjs';
import {
  createTenantOperationLock,
  formatTenantLockError,
  runTenantLockDiagnostic,
  runWithTenantLock,
  TENANT_LOCK_BLOB_PATH,
} from '../runtime/tenant-lock.mjs';

const tenantId = '11111111-1111-1111-1111-111111111111';
const operationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const operationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const commit = 'c'.repeat(40);
const start = Date.parse('2026-07-19T12:00:00.000Z');

function operation(operationId, overrides = {}) {
  return {
    tenantId,
    operationId,
    kind: 'install-runtime',
    source: 'spa',
    commit,
    ...overrides,
  };
}

function uuidSource(...values) {
  let index = 0;
  return () => values[index++] ?? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
}

class MemoryLeaseStore {
  constructor(now) {
    this.now = now;
    this.entries = new Map();
  }

  active(key) {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > this.now() ? entry : undefined;
  }

  async acquire({ key, leaseId, leaseDurationSeconds, record }) {
    const active = this.active(key);
    if (active) {
      return { acquired: false, record: active.record };
    }
    this.entries.set(key, {
      leaseId,
      expiresAt: this.now() + leaseDurationSeconds * 1000,
      record,
    });
    return { acquired: true };
  }

  async renew({ key, leaseId, leaseDurationSeconds, record }) {
    const active = this.active(key);
    if (!active || active.leaseId !== leaseId) {
      return { renewed: false };
    }
    this.entries.set(key, {
      leaseId,
      expiresAt: this.now() + leaseDurationSeconds * 1000,
      record,
    });
    return { renewed: true };
  }

  async release({ key, leaseId, record }) {
    const active = this.active(key);
    if (!active || active.leaseId !== leaseId) {
      return { released: false };
    }
    this.entries.set(key, { leaseId: undefined, expiresAt: 0, record });
    return { released: true };
  }
}

function lockFor(store, now, leaseId) {
  return createTenantOperationLock({
    store,
    now,
    randomUUID: uuidSource(leaseId),
  });
}

test('exactly one operation owns the tenant lock and contention evidence is sanitized', async () => {
  let currentTime = start;
  const now = () => currentTime;
  const store = new MemoryLeaseStore(now);
  const firstLock = lockFor(store, now, '10101010-1010-4010-8010-101010101010');
  const secondLock = lockFor(store, now, '20202020-2020-4020-8020-202020202020');
  const first = await firstLock.acquire(operation(operationA));

  await assert.rejects(
    secondLock.acquire(operation(operationB, { source: 'github-actions' })),
    (error) => {
      assert.equal(error.code, 'lock_busy');
      assert.equal(error.evidence.state, 'blocked');
      assert.equal(error.evidence.owner.operationId, operationA);
      assert.equal(error.evidence.owner.source, 'spa');
      assert.equal(error.evidence.operation.operationId, operationB);
      assert.equal(error.evidence.retryAfterSeconds, 30);
      assert.doesNotMatch(JSON.stringify(error.evidence), /lease|token|authorization/i);
      return true;
    },
  );

  const released = await first.release();
  assert.equal(released.state, 'released');
  const second = await secondLock.acquire(operation(operationB));
  assert.equal(second.evidence().owner.operationId, operationB);
  await second.release();
  currentTime += 1;
});

test('simultaneous acquisitions produce one owner and one blocked caller', async () => {
  const now = () => start;
  const store = new MemoryLeaseStore(now);
  const firstLock = lockFor(store, now, '21212121-2121-4212-8212-212121212121');
  const secondLock = lockFor(store, now, '23232323-2323-4232-8232-232323232323');

  const attempts = await Promise.allSettled([
    firstLock.acquire(operation(operationA)),
    secondLock.acquire(operation(operationB, { source: 'github-actions' })),
  ]);
  const owners = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const blocked = attempts.filter((attempt) => attempt.status === 'rejected');

  assert.equal(owners.length, 1);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason.code, 'lock_busy');
  assert.equal(
    blocked[0].reason.evidence.owner.operationId,
    owners[0].value.evidence().owner.operationId,
  );
  await owners[0].value.release();
});

test('renewal extends ownership and expiration recovers from a crashed operation', async () => {
  let currentTime = start;
  const now = () => currentTime;
  const store = new MemoryLeaseStore(now);
  const firstLock = lockFor(store, now, '30303030-3030-4030-8030-303030303030');
  const secondLock = lockFor(store, now, '40404040-4040-4040-8040-404040404040');
  const first = await firstLock.acquire(operation(operationA));

  currentTime += 10_000;
  const renewed = await first.renew();
  assert.equal(renewed.renewedAt, '2026-07-19T12:00:10.000Z');
  assert.equal(renewed.expiresAt, '2026-07-19T12:00:40.000Z');

  currentTime += 31_000;
  const recovered = await secondLock.acquire(operation(operationB));
  assert.equal(recovered.evidence().owner.operationId, operationB);
  await assert.rejects(first.renew(), (error) => error.code === 'lock_lost');
  await assert.rejects(first.release(), (error) => error.code === 'lock_lost');
  await recovered.release();
});

test('the diagnostic uses the shared operation boundary and is blocked by real work', async () => {
  const now = () => start;
  const store = new MemoryLeaseStore(now);
  const operationLock = lockFor(store, now, '50505050-5050-4050-8050-505050505050');
  const diagnosticLock = lockFor(store, now, '60606060-6060-4060-8060-606060606060');
  let operationStarted;
  let finishOperation;
  const started = new Promise((resolve) => {
    operationStarted = resolve;
  });
  const finish = new Promise((resolve) => {
    finishOperation = resolve;
  });

  const running = runWithTenantLock({
    lock: operationLock,
    operation: operation(operationA),
    execute: async ({ operationId, lockEvidence }) => {
      assert.equal(operationId, operationA);
      assert.equal(lockEvidence().state, 'held');
      operationStarted();
      await finish;
      return { state: 'operation-complete' };
    },
  });
  await started;

  await assert.rejects(
    runTenantLockDiagnostic({
      lock: diagnosticLock,
      tenantId,
      operationId: operationB,
      source: 'github-actions',
      commit,
    }),
    (error) => error.code === 'lock_busy' && error.evidence.owner.operationId === operationA,
  );

  finishOperation();
  const completed = await running;
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.lock.released.state, 'released');

  const diagnostic = await runTenantLockDiagnostic({
    lock: diagnosticLock,
    tenantId,
    operationId: operationB,
    source: 'github-actions',
    commit,
  });
  assert.deepEqual(diagnostic.result, {
    state: 'exclusive-lock-confirmed',
    tenantId,
    operationId: operationB,
    source: 'github-actions',
    commit,
    holdSeconds: 0,
  });
  assert.equal(diagnostic.lock.released.state, 'released');
});

test('the bounded diagnostic hold window supports a repeatable contention proof', async () => {
  const now = () => start;
  const store = new MemoryLeaseStore(now);
  const firstLock = lockFor(store, now, '61616161-6161-4161-8161-616161616161');
  const secondLock = lockFor(store, now, '62626262-6262-4262-8262-626262626262');
  let holdStarted;
  let finishHold;
  const started = new Promise((resolve) => {
    holdStarted = resolve;
  });
  const finish = new Promise((resolve) => {
    finishHold = resolve;
  });

  const first = runTenantLockDiagnostic({
    lock: firstLock,
    tenantId,
    operationId: operationA,
    source: 'github-actions',
    commit,
    holdSeconds: 5,
    wait: async (milliseconds) => {
      assert.equal(milliseconds, 5_000);
      holdStarted();
      await finish;
    },
  });
  await started;

  await assert.rejects(
    runTenantLockDiagnostic({
      lock: secondLock,
      tenantId,
      operationId: operationB,
      source: 'spa',
      commit,
    }),
    (error) => error.code === 'lock_busy' && error.evidence.owner.operationId === operationA,
  );
  finishHold();
  const result = await first;

  assert.equal(result.result.holdSeconds, 5);
  assert.equal(result.lock.released.state, 'released');
  assert.throws(
    () =>
      runTenantLockDiagnostic({
        lock: firstLock,
        tenantId,
        operationId: operationA,
        source: 'spa',
        commit,
        holdSeconds: 11,
      }),
    (error) => error.code === 'lock_request_invalid',
  );
});

test('the shared operation boundary releases the lock when work fails', async () => {
  const now = () => start;
  const store = new MemoryLeaseStore(now);
  const firstLock = lockFor(store, now, '70707070-7070-4070-8070-707070707070');
  const secondLock = lockFor(store, now, '80808080-8080-4080-8080-808080808080');

  await assert.rejects(
    runWithTenantLock({
      lock: firstLock,
      operation: operation(operationA),
      execute: async () => {
        throw new Error('operation failed');
      },
    }),
    /operation failed/,
  );

  const next = await secondLock.acquire(operation(operationB));
  await next.release();
});

test('invalid requests and malformed stored ownership never expose arbitrary content', async () => {
  const store = {
    acquire: async () => ({
      acquired: false,
      record: {
        schemaVersion: 1,
        state: 'held',
        tenantId,
        owner: {
          operationId: operationA,
          kind: '<script>secret</script>',
          source: 'unknown-source',
          commit,
          accessToken: 'top-secret-token',
        },
        acquiredAt: new Date(start).toISOString(),
        expiresAt: new Date(start + 30_000).toISOString(),
      },
    }),
    renew: async () => ({ renewed: false }),
    release: async () => ({ released: false }),
  };
  const lock = lockFor(store, () => start, '90909090-9090-4090-8090-909090909090');

  await assert.rejects(lock.acquire(operation(operationA)), (error) => {
    assert.equal(error.code, 'lock_busy');
    assert.equal(Object.hasOwn(error.evidence, 'owner'), false);
    assert.equal(error.evidence.retryAfterSeconds, 30);
    assert.doesNotMatch(JSON.stringify(error.evidence), /secret|script|token/i);
    return true;
  });
  await assert.rejects(
    lock.acquire(operation(operationA, { source: 'browser', commit: 'abc123' })),
    (error) => error.code === 'lock_request_invalid',
  );
  assert.match(formatTenantLockError({ code: 'lock_busy' }), /already running/i);
});

function createBlobServiceMock() {
  let exists = false;
  let leaseId;
  let record = '{}';
  const requests = [];

  return {
    requests,
    async fetch(url, options) {
      const headers = new Headers(options.headers);
      const request = {
        url,
        method: options.method,
        headers: Object.fromEntries(headers.entries()),
        body: options.body,
      };
      requests.push(request);
      const parsedUrl = new URL(url);
      const action = headers.get('x-ms-lease-action');

      if (parsedUrl.searchParams.get('comp') === 'lease') {
        if (action === 'acquire') {
          if (leaseId) {
            return new Response('', {
              status: 409,
              headers: { 'x-ms-error-code': 'LeaseAlreadyPresent' },
            });
          }
          leaseId = headers.get('x-ms-proposed-lease-id');
          return new Response('', { status: 201, headers: { 'x-ms-lease-id': leaseId } });
        }
        if (headers.get('x-ms-lease-id') !== leaseId) {
          return new Response('', {
            status: 409,
            headers: { 'x-ms-error-code': 'LeaseIdMismatchWithLeaseOperation' },
          });
        }
        if (action === 'renew') {
          return new Response('', { status: 200, headers: { 'x-ms-lease-id': leaseId } });
        }
        if (action === 'release') {
          leaseId = undefined;
          return new Response('', { status: 200 });
        }
      }

      if (options.method === 'GET') {
        return exists ? new Response(record, { status: 200 }) : new Response('', { status: 404 });
      }
      if (options.method === 'HEAD') {
        return new Response('', { status: exists ? 200 : 404 });
      }
      if (headers.get('if-none-match') === '*') {
        if (exists) {
          return new Response('', {
            status: 412,
            headers: { 'x-ms-error-code': 'ConditionNotMet' },
          });
        }
        exists = true;
        record = options.body;
        return new Response('', { status: 201 });
      }
      if (headers.get('x-ms-lease-id') !== leaseId) {
        return new Response('', {
          status: 412,
          headers: { 'x-ms-error-code': 'LeaseIdMissing' },
        });
      }
      record = options.body;
      return new Response('', { status: 201 });
    },
  };
}

test('the Blob REST adapter uses one fixed leased record for acquire, renew, contention, and release', async () => {
  let currentTime = start;
  const now = () => currentTime;
  const service = createBlobServiceMock();
  const token = 'storage-access-token-that-must-not-enter-evidence';
  const store = createBlobLeaseStore({
    containerUrl: 'https://apstate.blob.core.windows.net/state',
    getAccessToken: async () => token,
    fetch: service.fetch,
    now,
    randomUUID: uuidSource(
      '11111111-2222-4333-8444-555555555555',
      '22222222-3333-4444-8555-666666666666',
      '33333333-4444-4555-8666-777777777777',
      '44444444-5555-4666-8777-888888888888',
      '55555555-6666-4777-8888-999999999999',
      '66666666-7777-4888-8999-aaaaaaaaaaaa',
      '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
      '88888888-9999-4aaa-8bbb-cccccccccccc',
      '99999999-aaaa-4bbb-8ccc-dddddddddddd',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      'cccccccc-dddd-4eee-8fff-000000000000',
    ),
  });
  const firstLock = lockFor(store, now, '12121212-1212-4212-8212-121212121212');
  const secondLock = lockFor(store, now, '34343434-3434-4434-8434-343434343434');
  const first = await firstLock.acquire(operation(operationA));

  currentTime += 5_000;
  await first.renew();
  await assert.rejects(
    secondLock.acquire(operation(operationB)),
    (error) => error.code === 'lock_busy' && error.evidence.owner.operationId === operationA,
  );
  await first.release();
  const second = await secondLock.acquire(operation(operationB));
  await second.release();

  const blobPath = `/state/${TENANT_LOCK_BLOB_PATH}`;
  assert.equal(service.requests.every((request) => new URL(request.url).pathname === blobPath), true);
  assert.equal(
    service.requests.every((request) => request.headers.authorization === `Bearer ${token}`),
    true,
  );
  assert.equal(
    service.requests.some((request) => request.headers['x-ms-lease-action'] === 'renew'),
    true,
  );
  assert.equal(
    service.requests.filter((request) => request.headers['x-ms-lease-action'] === 'acquire').length,
    3,
  );
  for (const request of service.requests.filter((entry) => typeof entry.body === 'string')) {
    assert.doesNotMatch(request.body, /storage-access-token|x-ms-lease-id/i);
  }
  assert.doesNotMatch(
    JSON.stringify(first.evidence()),
    /storage-access-token|x-ms-lease-id|12121212-1212-4212-8212-121212121212/i,
  );
});
