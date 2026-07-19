const TOKEN_API_VERSION = '2019-08-01';

export class ManagedIdentityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function required(value) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new ManagedIdentityError('managed_identity_unavailable');
  return normalized;
}

export function createManagedIdentityCredential({
  endpoint,
  identityHeader,
  clientId,
  fetch: fetchToken = globalThis.fetch,
  now = Date.now,
} = {}) {
  let url;
  try {
    url = new URL(required(endpoint));
  } catch {
    throw new ManagedIdentityError('managed_identity_unavailable');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ManagedIdentityError('managed_identity_unavailable');
  }
  const header = required(identityHeader);
  const selectedClientId = required(clientId);
  if (typeof fetchToken !== 'function' || typeof now !== 'function') {
    throw new ManagedIdentityError('managed_identity_unavailable');
  }
  let cached;

  return Object.freeze({
    async getToken(resource) {
      const requestedResource = required(resource);
      const nowSeconds = Math.floor(Number(now()) / 1000);
      if (cached?.resource === requestedResource && cached.expiresOn > nowSeconds + 300) {
        return cached.token;
      }
      const requestUrl = new URL(url);
      requestUrl.searchParams.set('api-version', TOKEN_API_VERSION);
      requestUrl.searchParams.set('resource', requestedResource);
      requestUrl.searchParams.set('client_id', selectedClientId);
      let response;
      try {
        response = await fetchToken(requestUrl, {
          method: 'GET',
          headers: { 'X-IDENTITY-HEADER': header },
        });
      } catch {
        throw new ManagedIdentityError('managed_identity_unavailable');
      }
      if (!response?.ok) throw new ManagedIdentityError('managed_identity_unavailable');
      let body;
      try {
        body = await response.json();
      } catch {
        throw new ManagedIdentityError('managed_identity_unavailable');
      }
      const token = required(body?.access_token);
      const expiresOn = Number(body?.expires_on);
      if (!Number.isSafeInteger(expiresOn) || expiresOn <= nowSeconds) {
        throw new ManagedIdentityError('managed_identity_unavailable');
      }
      cached = Object.freeze({ expiresOn, resource: requestedResource, token });
      return token;
    },
  });
}
