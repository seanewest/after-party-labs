const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const OPERATION_PATTERN = /^[a-z][a-z0-9.-]{2,79}$/;
const RUNTIME_ID_PATTERN = /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[A-Za-z0-9._()\-]+\/providers\/Microsoft\.App\/containerApps\/[a-z0-9-]+$/i;

export const RUNTIME_API_SCOPE_NAME = 'AfterParty.Operate';

export class RuntimeAuthorizationError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new RuntimeAuthorizationError(code, status);
}

function requiredUuid(value, code = 'request_invalid') {
  const normalized = String(value || '').toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    fail(code, 400);
  }
  return normalized;
}

function requiredCommit(value, code = 'request_invalid') {
  const normalized = String(value || '').toLowerCase();
  if (!COMMIT_PATTERN.test(normalized)) {
    fail(code, 400);
  }
  return normalized;
}

function requiredRuntimeId(value, code = 'request_invalid') {
  const normalized = String(value || '');
  if (!RUNTIME_ID_PATTERN.test(normalized)) {
    fail(code, 400);
  }
  return normalized.toLowerCase();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function validateConfiguration(configuration) {
  if (!isPlainObject(configuration)) {
    fail('runtime_misconfigured', 500);
  }
  const tenantId = requiredUuid(configuration.tenantId, 'runtime_misconfigured');
  const applicationId = requiredUuid(configuration.applicationId, 'runtime_misconfigured');
  const runtimeId = requiredRuntimeId(configuration.runtimeId, 'runtime_misconfigured');
  const commit = requiredCommit(configuration.commit, 'runtime_misconfigured');
  const operations = Array.isArray(configuration.allowedOperations)
    ? [...new Set(configuration.allowedOperations.map((value) => String(value || '')))]
    : [];
  if (!operations.length || operations.some((operation) => !OPERATION_PATTERN.test(operation))) {
    fail('runtime_misconfigured', 500);
  }
  return Object.freeze({ applicationId, commit, operations, runtimeId, tenantId });
}

function validateRequest(request, configuration) {
  if (!isPlainObject(request)) {
    fail('request_invalid', 400);
  }
  const allowedKeys = new Set(['commit', 'operation', 'requestId', 'runtimeId', 'tenantId']);
  if (Object.keys(request).some((key) => !allowedKeys.has(key)) || Object.keys(request).length !== 5) {
    fail('request_invalid', 400);
  }
  const operation = String(request.operation || '');
  const requestId = requiredUuid(request.requestId);
  const tenantId = requiredUuid(request.tenantId);
  const runtimeId = requiredRuntimeId(request.runtimeId);
  const commit = requiredCommit(request.commit);
  if (!configuration.operations.includes(operation)) {
    fail('operation_not_allowed', 403);
  }
  if (tenantId !== configuration.tenantId) {
    fail('wrong_tenant', 403);
  }
  if (runtimeId !== configuration.runtimeId) {
    fail('wrong_runtime', 409);
  }
  if (commit !== configuration.commit) {
    fail('stale_runtime', 409);
  }
  return Object.freeze({ commit, operation, requestId, runtimeId, tenantId });
}

function claimValues(principal) {
  if (!isPlainObject(principal) || principal.authenticated !== true || !isPlainObject(principal.claims)) {
    fail('session_invalid', 401);
  }
  return principal.claims;
}

function validatePrincipal(principal, configuration, nowSeconds) {
  const claims = claimValues(principal);
  const tenantId = requiredUuid(claims.tid, 'session_invalid');
  const operatorId = requiredUuid(claims.oid, 'session_invalid');
  const issuer = String(claims.iss || '');
  const audience = String(claims.aud || '').toLowerCase();
  const authorizedParty = String(claims.azp || '').toLowerCase();
  const scopes = new Set(String(claims.scp || '').split(/\s+/).filter(Boolean));
  const expiresAt = Number(claims.exp);
  const validAfter = Number(claims.nbf ?? 0);

  if (
    claims.ver !== '2.0' ||
    issuer !== `https://login.microsoftonline.com/${tenantId}/v2.0` ||
    audience !== configuration.applicationId ||
    authorizedParty !== configuration.applicationId
  ) {
    fail('session_invalid', 401);
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || !Number.isSafeInteger(validAfter) || validAfter > nowSeconds) {
    fail('session_expired', 401);
  }
  if (tenantId !== configuration.tenantId) {
    fail('wrong_tenant', 403);
  }
  if (!scopes.has(RUNTIME_API_SCOPE_NAME)) {
    fail('insufficient_scope', 403);
  }
  return Object.freeze({ expiresAt, operatorId, tenantId });
}

function validateInstallation(installation, configuration) {
  if (!isPlainObject(installation) || installation.status !== 'verified') {
    fail('installation_missing', 409);
  }
  const tenantId = requiredUuid(installation.tenantId, 'installation_invalid');
  const applicationId = requiredUuid(installation.applicationId, 'installation_invalid');
  const runtimeId = requiredRuntimeId(installation.runtimeId, 'installation_invalid');
  const commit = requiredCommit(installation.commit, 'installation_invalid');
  if (
    tenantId !== configuration.tenantId ||
    applicationId !== configuration.applicationId ||
    runtimeId !== configuration.runtimeId
  ) {
    fail('installation_invalid', 409);
  }
  if (commit !== configuration.commit) {
    fail('stale_runtime', 409);
  }
}

export function formatRuntimeAuthorizationError(error) {
  const messages = {
    installation_invalid: 'The installed runtime does not match this tenant.',
    installation_missing: 'Install or repair the tenant runtime before running this operation.',
    insufficient_scope: 'Reconnect the tenant to grant After Party runtime access.',
    operation_not_allowed: 'This runtime does not allow the requested operation.',
    replay_detected: 'This request was already received. Start the operation again.',
    request_invalid: 'The operation request is incomplete or malformed.',
    runtime_misconfigured: 'The tenant runtime authorization settings are incomplete.',
    session_expired: 'Your After Party session expired. Sign in again.',
    session_invalid: 'After Party could not verify the signed-in operator.',
    stale_runtime: 'The SPA and tenant runtime are on different commits. Repair the runtime and retry.',
    wrong_runtime: 'The request targets a different tenant runtime.',
    wrong_tenant: 'The signed-in tenant does not match this tenant runtime.',
  };
  return messages[error?.code] || 'After Party could not authorize this operation.';
}

export function createRuntimeOperationAuthorizer({ configuration, replayStore, now = () => Date.now() }) {
  const expected = validateConfiguration(configuration);
  if (!replayStore || typeof replayStore.claim !== 'function' || typeof now !== 'function') {
    fail('runtime_misconfigured', 500);
  }

  return Object.freeze({
    async authorize({ principal, request, installation }) {
      const nowMilliseconds = Number(now());
      if (!Number.isFinite(nowMilliseconds)) {
        fail('runtime_misconfigured', 500);
      }
      const nowSeconds = Math.floor(nowMilliseconds / 1000);
      const operator = validatePrincipal(principal, expected, nowSeconds);
      const validatedRequest = validateRequest(request, expected);
      validateInstallation(installation, expected);

      const claimed = await replayStore.claim({
        tenantId: expected.tenantId,
        operatorId: operator.operatorId,
        requestId: validatedRequest.requestId,
        expiresAt: operator.expiresAt,
      });
      if (claimed !== true) {
        fail('replay_detected', 409);
      }

      return Object.freeze({
        status: 'authorized',
        operation: validatedRequest.operation,
        requestId: validatedRequest.requestId,
        tenantId: expected.tenantId,
        runtimeId: expected.runtimeId,
        commit: expected.commit,
      });
    },
  });
}
