const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const OPERATION_KIND_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
const OPERATION_SOURCES = new Set([
  'spa',
  'github-actions',
  'local-spa',
  'tenant-job',
]);

export const TENANT_LOCK_BLOB_PATH = 'locks/tenant-operation.json';
export const DEFAULT_TENANT_LOCK_LEASE_SECONDS = 30;
export const MIN_TENANT_LOCK_LEASE_SECONDS = 15;
export const MAX_TENANT_LOCK_LEASE_SECONDS = 60;
export const MAX_TENANT_LOCK_DIAGNOSTIC_HOLD_SECONDS = 10;

export class TenantLockError extends Error {
  constructor(code, evidence) {
    super(code);
    this.code = code;
    this.evidence = evidence;
  }
}

function frozenObject(value) {
  return Object.freeze(value);
}

function requireUuid(value, code) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new TenantLockError(code);
  }
  return normalized;
}

function requireCommit(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!COMMIT_PATTERN.test(normalized)) {
    throw new TenantLockError('lock_request_invalid');
  }
  return normalized;
}

function requireOperationKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!OPERATION_KIND_PATTERN.test(normalized)) {
    throw new TenantLockError('lock_request_invalid');
  }
  return normalized;
}

function requireOperationSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!OPERATION_SOURCES.has(normalized)) {
    throw new TenantLockError('lock_request_invalid');
  }
  return normalized;
}

function requireLeaseDuration(value) {
  if (
    !Number.isInteger(value) ||
    value < MIN_TENANT_LOCK_LEASE_SECONDS ||
    value > MAX_TENANT_LOCK_LEASE_SECONDS
  ) {
    throw new TypeError(
      `Tenant lock lease duration must be ${MIN_TENANT_LOCK_LEASE_SECONDS}-${MAX_TENANT_LOCK_LEASE_SECONDS} seconds.`,
    );
  }
  return value;
}

function timestamp(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('Tenant lock clock must return milliseconds.');
  }
  return new Date(milliseconds).toISOString();
}

function normalizeOperation(input, randomUUID) {
  if (!input || typeof input !== 'object') {
    throw new TenantLockError('lock_request_invalid');
  }
  return frozenObject({
    tenantId: requireUuid(input.tenantId, 'lock_request_invalid'),
    operationId: requireUuid(input.operationId ?? randomUUID(), 'lock_request_invalid'),
    kind: requireOperationKind(input.kind),
    source: requireOperationSource(input.source),
    commit: requireCommit(input.commit),
  });
}

function ownerEvidence(operation) {
  return frozenObject({
    operationId: operation.operationId,
    kind: operation.kind,
    source: operation.source,
    commit: operation.commit,
  });
}

function heldEvidence(operation, acquiredAt, expiresAt, renewedAt) {
  return frozenObject({
    schemaVersion: 1,
    state: 'held',
    tenantId: operation.tenantId,
    owner: ownerEvidence(operation),
    acquiredAt,
    ...(renewedAt ? { renewedAt } : {}),
    expiresAt,
  });
}

function releasedEvidence(held, releasedAt) {
  return frozenObject({
    schemaVersion: 1,
    state: 'released',
    tenantId: held.tenantId,
    owner: held.owner,
    acquiredAt: held.acquiredAt,
    ...(held.renewedAt ? { renewedAt: held.renewedAt } : {}),
    expiresAt: held.expiresAt,
    releasedAt,
  });
}

function sanitizedStoredEvidence(value, expectedTenantId) {
  try {
    if (
      value?.schemaVersion !== 1 ||
      value?.state !== 'held' ||
      requireUuid(value.tenantId, 'invalid') !== expectedTenantId
    ) {
      return undefined;
    }
    const operation = frozenObject({
      operationId: requireUuid(value.owner?.operationId, 'invalid'),
      kind: requireOperationKind(value.owner?.kind),
      source: requireOperationSource(value.owner?.source),
      commit: requireCommit(value.owner?.commit),
    });
    const acquiredAt = timestamp(Date.parse(value.acquiredAt));
    const expiresAt = timestamp(Date.parse(value.expiresAt));
    const renewedAt = value.renewedAt ? timestamp(Date.parse(value.renewedAt)) : undefined;
    return frozenObject({
      schemaVersion: 1,
      state: 'held',
      tenantId: expectedTenantId,
      owner: ownerEvidence(operation),
      acquiredAt,
      ...(renewedAt ? { renewedAt } : {}),
      expiresAt,
    });
  } catch {
    return undefined;
  }
}

function blockedEvidence(operation, current, nowMilliseconds, leaseDurationSeconds) {
  const expiresAtMilliseconds = current ? Date.parse(current.expiresAt) : Number.NaN;
  const retryAfterSeconds = Number.isFinite(expiresAtMilliseconds)
    ? Math.max(1, Math.ceil((expiresAtMilliseconds - nowMilliseconds) / 1000))
    : leaseDurationSeconds;
  return frozenObject({
    schemaVersion: 1,
    state: 'blocked',
    tenantId: operation.tenantId,
    operation: ownerEvidence(operation),
    ...(current ? { owner: current.owner, acquiredAt: current.acquiredAt, expiresAt: current.expiresAt } : {}),
    retryAfterSeconds,
  });
}

function lostEvidence(operation, action) {
  return frozenObject({
    schemaVersion: 1,
    state: 'lost',
    tenantId: operation.tenantId,
    operation: ownerEvidence(operation),
    action,
  });
}

function storageError() {
  return new TenantLockError('lock_storage_unavailable');
}

export function formatTenantLockError(error) {
  const messages = {
    lock_request_invalid: 'The tenant operation lock request is invalid.',
    lock_busy: 'Another tenant-changing operation is already running.',
    lock_lost: 'This operation no longer owns the tenant lock.',
    lock_storage_unavailable: 'After Party could not reach the tenant operation lock.',
  };
  let code;
  try {
    code = error?.code;
  } catch {
    return 'After Party could not use the tenant operation lock.';
  }
  return messages[code] || 'After Party could not use the tenant operation lock.';
}

export function createTenantOperationLock({
  store,
  now = Date.now,
  randomUUID = () => globalThis.crypto.randomUUID(),
  leaseDurationSeconds = DEFAULT_TENANT_LOCK_LEASE_SECONDS,
} = {}) {
  for (const method of ['acquire', 'renew', 'release']) {
    if (typeof store?.[method] !== 'function') {
      throw new TypeError(`Tenant lock store must implement ${method}().`);
    }
  }
  if (typeof now !== 'function' || typeof randomUUID !== 'function') {
    throw new TypeError('Tenant lock clock and UUID source must be functions.');
  }
  const duration = requireLeaseDuration(leaseDurationSeconds);

  return frozenObject({
    async acquire(input) {
      const operation = normalizeOperation(input, randomUUID);
      const leaseId = requireUuid(randomUUID(), 'lock_request_invalid');
      const acquiredAtMilliseconds = now();
      const acquiredAt = timestamp(acquiredAtMilliseconds);
      const record = heldEvidence(
        operation,
        acquiredAt,
        timestamp(acquiredAtMilliseconds + duration * 1000),
      );
      let result;
      try {
        result = await store.acquire({
          key: TENANT_LOCK_BLOB_PATH,
          leaseId,
          leaseDurationSeconds: duration,
          record,
        });
      } catch (error) {
        throw storageError(error);
      }
      if (!result?.acquired) {
        const current = sanitizedStoredEvidence(result?.record, operation.tenantId);
        throw new TenantLockError(
          'lock_busy',
          blockedEvidence(operation, current, acquiredAtMilliseconds, duration),
        );
      }

      let active = true;
      let latest = record;

      return frozenObject({
        evidence: () => latest,

        async renew() {
          if (!active) {
            throw new TenantLockError('lock_lost', lostEvidence(operation, 'renew'));
          }
          const renewedAtMilliseconds = now();
          const renewed = heldEvidence(
            operation,
            latest.acquiredAt,
            timestamp(renewedAtMilliseconds + duration * 1000),
            timestamp(renewedAtMilliseconds),
          );
          let renewal;
          try {
            renewal = await store.renew({
              key: TENANT_LOCK_BLOB_PATH,
              leaseId,
              leaseDurationSeconds: duration,
              record: renewed,
            });
          } catch (error) {
            throw storageError(error);
          }
          if (!renewal?.renewed) {
            active = false;
            throw new TenantLockError('lock_lost', lostEvidence(operation, 'renew'));
          }
          latest = renewed;
          return latest;
        },

        async release() {
          if (!active) {
            throw new TenantLockError('lock_lost', lostEvidence(operation, 'release'));
          }
          const released = releasedEvidence(latest, timestamp(now()));
          let release;
          try {
            release = await store.release({
              key: TENANT_LOCK_BLOB_PATH,
              leaseId,
              record: released,
            });
          } catch (error) {
            throw storageError(error);
          }
          active = false;
          if (!release?.released) {
            throw new TenantLockError('lock_lost', lostEvidence(operation, 'release'));
          }
          latest = released;
          return latest;
        },
      });
    },
  });
}

export async function runWithTenantLock({ lock, operation, execute }) {
  if (typeof lock?.acquire !== 'function' || typeof execute !== 'function') {
    throw new TypeError('A tenant lock and operation callback are required.');
  }
  const session = await lock.acquire(operation);
  try {
    const result = await execute({
      operationId: session.evidence().owner.operationId,
      lockEvidence: session.evidence,
      renewLock: session.renew,
    });
    const held = session.evidence();
    const released = await session.release();
    return frozenObject({
      state: 'succeeded',
      operationId: held.owner.operationId,
      result,
      lock: frozenObject({ held, released }),
    });
  } catch (error) {
    try {
      await session.release();
    } catch {
      // The original operation error remains the useful failure for the caller.
    }
    throw error;
  }
}

export function runTenantLockDiagnostic({
  lock,
  tenantId,
  operationId,
  source,
  commit,
  holdSeconds = 0,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (
    !Number.isInteger(holdSeconds) ||
    holdSeconds < 0 ||
    holdSeconds > MAX_TENANT_LOCK_DIAGNOSTIC_HOLD_SECONDS ||
    typeof wait !== 'function'
  ) {
    throw new TenantLockError('lock_request_invalid');
  }
  return runWithTenantLock({
    lock,
    operation: {
      tenantId,
      operationId,
      kind: 'lock-diagnostic',
      source,
      commit,
    },
    execute: async ({ lockEvidence }) => {
      if (holdSeconds) {
        await wait(holdSeconds * 1000);
      }
      const held = lockEvidence();
      return frozenObject({
        state: 'exclusive-lock-confirmed',
        tenantId: held.tenantId,
        operationId: held.owner.operationId,
        source: held.owner.source,
        commit: held.owner.commit,
        holdSeconds,
      });
    },
  });
}
