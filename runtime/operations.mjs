import {
  runTenantLockDiagnostic,
  TenantLockError,
} from './tenant-lock.mjs';

export class RuntimeOperationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function createRuntimeOperationExecutor({
  lock,
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (typeof lock?.acquire !== 'function' || typeof randomUUID !== 'function') {
    throw new RuntimeOperationError('runtime_misconfigured');
  }

  async function lockDiagnostic(authorized) {
    let announceOwner;
    let releaseOwner;
    const ownerStarted = new Promise((resolve) => { announceOwner = resolve; });
    const ownerRelease = new Promise((resolve) => { releaseOwner = resolve; });
    const owner = runTenantLockDiagnostic({
      lock,
      tenantId: authorized.tenantId,
      operationId: authorized.requestId,
      source: authorized.callerClass === 'github-federated-runtime' ? 'github-actions' : 'spa',
      commit: authorized.commit,
      holdSeconds: 1,
      wait: async () => {
        announceOwner();
        await ownerRelease;
      },
    });
    await Promise.race([
      ownerStarted,
      owner.then(
        () => { throw new RuntimeOperationError('lock_diagnostic_failed'); },
        (error) => { throw error; },
      ),
    ]);

    let contention;
    try {
      await runTenantLockDiagnostic({
        lock,
        tenantId: authorized.tenantId,
        operationId: randomUUID(),
        source: authorized.callerClass === 'github-federated-runtime' ? 'github-actions' : 'spa',
        commit: authorized.commit,
      });
    } catch (error) {
      contention = error;
    } finally {
      releaseOwner();
    }
    const completedOwner = await owner;
    if (!(contention instanceof TenantLockError) || contention.code !== 'lock_busy') {
      throw new RuntimeOperationError('lock_diagnostic_failed');
    }
    const recovered = await runTenantLockDiagnostic({
      lock,
      tenantId: authorized.tenantId,
      operationId: randomUUID(),
      source: authorized.callerClass === 'github-federated-runtime' ? 'github-actions' : 'spa',
      commit: authorized.commit,
    });
    if (
      completedOwner.result?.state !== 'exclusive-lock-confirmed' ||
      completedOwner.lock?.released?.state !== 'released' ||
      contention.evidence?.state !== 'blocked' ||
      recovered.result?.state !== 'exclusive-lock-confirmed' ||
      recovered.lock?.released?.state !== 'released'
    ) {
      throw new RuntimeOperationError('lock_diagnostic_failed');
    }
    return Object.freeze({
      ...authorized,
      diagnostic: Object.freeze({
        state: 'contention-confirmed',
        owner: 'exclusive',
        competitor: 'blocked',
        recovery: 'released',
      }),
    });
  }

  return Object.freeze({
    async run(authorized) {
      if (authorized?.operation === 'runtime.status') return authorized;
      if (authorized?.operation === 'lock.test') return lockDiagnostic(authorized);
      throw new RuntimeOperationError('operation_not_allowed');
    },
  });
}
