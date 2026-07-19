const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const OPERATION_PATTERN = /^[a-z][a-z0-9.-]{2,79}$/;
const RUNTIME_ID_PATTERN = /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[A-Za-z0-9._()\-]+\/providers\/Microsoft\.App\/containerApps\/[a-z0-9-]+$/i;

export class RuntimeApiError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new RuntimeApiError(code);
}

function requireText(value, pattern, code = 'runtime_configuration_invalid') {
  const normalized = String(value || '');
  if (!pattern.test(normalized)) {
    fail(code);
  }
  return normalized;
}

function validateConfiguration(configuration) {
  const tenantId = requireText(configuration?.tenantId, UUID_PATTERN).toLowerCase();
  const runtimeId = requireText(configuration?.runtimeId, RUNTIME_ID_PATTERN).toLowerCase();
  const commit = requireText(configuration?.commit, COMMIT_PATTERN).toLowerCase();
  const scope = String(configuration?.scope || '');
  if (!/^api:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/AfterParty\.Operate$/i.test(scope)) {
    fail('runtime_configuration_invalid');
  }
  let endpoint;
  try {
    endpoint = new URL(configuration.endpoint);
  } catch {
    fail('runtime_configuration_invalid');
  }
  const localHttp = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !localHttp) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail('runtime_configuration_invalid');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/operations`;
  return Object.freeze({ commit, endpoint: endpoint.href, runtimeId, scope, tenantId });
}

function validateResult(result, expected, requestId, operation) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('runtime_response_invalid');
  }
  if (
    result.status !== 'authorized' ||
    result.operation !== operation ||
    String(result.requestId || '').toLowerCase() !== requestId ||
    String(result.tenantId || '').toLowerCase() !== expected.tenantId ||
    String(result.runtimeId || '').toLowerCase() !== expected.runtimeId ||
    String(result.commit || '').toLowerCase() !== expected.commit
  ) {
    fail('runtime_response_invalid');
  }
  let diagnostic;
  if (operation === 'lock.test') {
    if (
      !result.diagnostic ||
      result.diagnostic.state !== 'contention-confirmed' ||
      result.diagnostic.owner !== 'exclusive' ||
      result.diagnostic.competitor !== 'blocked' ||
      result.diagnostic.recovery !== 'released'
    ) {
      fail('runtime_response_invalid');
    }
    diagnostic = Object.freeze({
      state: 'contention-confirmed',
      owner: 'exclusive',
      competitor: 'blocked',
      recovery: 'released',
    });
  }
  return Object.freeze({
    status: result.status,
    operation: result.operation,
    requestId,
    tenantId: expected.tenantId,
    runtimeId: expected.runtimeId,
    commit: expected.commit,
    ...(diagnostic ? { diagnostic } : {}),
  });
}

export function formatRuntimeApiError(error) {
  const messages = {
    installation_missing: 'Install or repair the tenant runtime before running this experiment.',
    insufficient_scope: 'Reconnect the tenant to grant After Party runtime access.',
    lock_busy: 'Another tenant-changing operation is already running. Wait for it to finish and try again.',
    operation_not_allowed: 'This operation is not available in the installed runtime.',
    replay_detected: 'That request was already received. Start the experiment again.',
    runtime_configuration_invalid: 'The tenant runtime connection is incomplete.',
    runtime_response_invalid: 'The tenant runtime returned an unexpected result.',
    runtime_unavailable: 'The tenant runtime could not be reached.',
    session_expired: 'Your After Party session expired. Sign in again.',
    session_invalid: 'After Party could not verify the signed-in operator.',
    stale_runtime: 'The SPA and tenant runtime are on different commits. Repair the runtime and retry.',
    wrong_runtime: 'The installed runtime does not match this request.',
    wrong_tenant: 'The signed-in tenant does not match the installed runtime.',
  };
  return messages[error?.code] || 'After Party could not call the tenant runtime.';
}

export function createRuntimeApiClient({ configuration, acquireAccessToken, fetchRuntime, randomUUID }) {
  const expected = validateConfiguration(configuration);
  if (typeof acquireAccessToken !== 'function' || typeof fetchRuntime !== 'function' || typeof randomUUID !== 'function') {
    fail('runtime_configuration_invalid');
  }

  return Object.freeze({
    async run(operation) {
      const normalizedOperation = String(operation || '');
      if (!OPERATION_PATTERN.test(normalizedOperation)) {
        fail('operation_not_allowed');
      }
      const requestId = requireText(randomUUID(), UUID_PATTERN, 'runtime_configuration_invalid').toLowerCase();
      let accessToken;
      try {
        accessToken = await acquireAccessToken(expected.scope);
      } catch (error) {
        fail(error?.code === 'token_unavailable' ? 'session_expired' : 'session_invalid');
      }
      if (!accessToken) {
        fail('session_invalid');
      }

      let response;
      try {
        response = await fetchRuntime(expected.endpoint, {
          method: 'POST',
          cache: 'no-store',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            operation: normalizedOperation,
            requestId,
            tenantId: expected.tenantId,
            runtimeId: expected.runtimeId,
            commit: expected.commit,
          }),
        });
      } catch {
        fail('runtime_unavailable');
      }

      let body;
      try {
        body = await response.json();
      } catch {
        fail('runtime_response_invalid');
      }
      if (!response.ok) {
        const safeCode = String(body?.code || '');
        const allowedCodes = new Set([
          'installation_missing',
          'insufficient_scope',
          'lock_busy',
          'operation_not_allowed',
          'replay_detected',
          'session_expired',
          'session_invalid',
          'stale_runtime',
          'wrong_runtime',
          'wrong_tenant',
        ]);
        fail(allowedCodes.has(safeCode) ? safeCode : 'runtime_unavailable');
      }
      return validateResult(body, expected, requestId, normalizedOperation);
    },
  });
}
