import { Buffer } from 'node:buffer';

import { RuntimeAuthorizationError } from './authorization.mjs';
import { TenantLockError } from './tenant-lock.mjs';

const CLAIM_NAMES = Object.freeze({
  'http://schemas.microsoft.com/identity/claims/objectidentifier': 'oid',
  'http://schemas.microsoft.com/identity/claims/scope': 'scp',
  'http://schemas.microsoft.com/identity/claims/tenantid': 'tid',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': 'roles',
});

function rejected(status, code) {
  return Object.freeze({
    status,
    headers: Object.freeze({
      'cache-control': 'no-store',
      'content-type': 'application/json',
    }),
    body: Object.freeze({ status: 'rejected', code }),
  });
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && typeof value === 'string') {
      return value;
    }
  }
  return '';
}

export function decodeContainerAppsPrincipal(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 32_768) {
    throw new RuntimeAuthorizationError('session_invalid', 401);
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new RuntimeAuthorizationError('session_invalid', 401);
  }
  if (!value || value.auth_typ !== 'aad' || !Array.isArray(value.claims)) {
    throw new RuntimeAuthorizationError('session_invalid', 401);
  }
  const claims = {};
  for (const claim of value.claims) {
    const originalName = String(claim?.typ || '');
    const name = CLAIM_NAMES[originalName.toLowerCase()] || originalName;
    if (!name || !['aud', 'azp', 'exp', 'iss', 'nbf', 'oid', 'roles', 'scp', 'tid', 'ver'].includes(name)) {
      continue;
    }
    if (Object.hasOwn(claims, name)) {
      throw new RuntimeAuthorizationError('session_invalid', 401);
    }
    claims[name] = ['exp', 'nbf'].includes(name) ? Number(claim.val) : String(claim.val || '');
  }
  return Object.freeze({ authenticated: true, claims: Object.freeze(claims) });
}

export function createRuntimeAuthorizationHandler({
  authorizer,
  getInstallation,
  runOperation = async (authorized) => authorized,
}) {
  if (
    !authorizer ||
    typeof authorizer.authorize !== 'function' ||
    typeof getInstallation !== 'function' ||
    typeof runOperation !== 'function'
  ) {
    throw new RuntimeAuthorizationError('runtime_misconfigured', 500);
  }
  return Object.freeze({
    async handle(request) {
      if (request?.method !== 'POST' || request?.path !== '/operations') {
        return rejected(404, 'operation_not_allowed');
      }
      try {
        const principal = decodeContainerAppsPrincipal(
          headerValue(request.headers, 'x-ms-client-principal'),
        );
        const installation = await getInstallation();
        const authorized = await authorizer.authorize({
          principal,
          request: request.body,
          installation,
        });
        const result = await runOperation(authorized);
        return Object.freeze({
          status: 200,
          headers: Object.freeze({
            'cache-control': 'no-store',
            'content-type': 'application/json',
          }),
          body: result,
        });
      } catch (error) {
        if (error instanceof RuntimeAuthorizationError) {
          return rejected(error.status, error.code);
        }
        if (error instanceof TenantLockError && error.code === 'lock_busy') {
          return rejected(409, 'lock_busy');
        }
        return rejected(503, 'runtime_unavailable');
      }
    },
  });
}
