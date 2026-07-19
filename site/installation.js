const CONSENT_STATE_KEY = 'after-party.admin-consent';
const CONSENT_STATE_LIFETIME_MS = 10 * 60 * 1000;
const MICROSOFT_GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const AZURE_SERVICE_MANAGEMENT_APP_ID = '797f4846-ba00-4fd7-ba43-dac1f8f63013';
const BENIGN_IDENTITY_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);
const RETRYABLE_VERIFICATION_CODES = new Set([
  'enterprise_app_missing',
  'graph_resource_invalid',
  'delegated_grant_missing',
  'delegated_grant_partial',
  'azure_resource_invalid',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InstallationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireUuid(value, code) {
  const normalized = String(value || '').trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new InstallationError(code);
  }
  return normalized.toLowerCase();
}

function requireRedirectUri(value) {
  let redirectUri;
  try {
    redirectUri = new URL(value);
  } catch {
    throw new InstallationError('configuration_invalid');
  }
  const localHttp =
    redirectUri.protocol === 'http:' &&
    (redirectUri.hostname === '127.0.0.1' || redirectUri.hostname === 'localhost');
  if (redirectUri.protocol !== 'https:' && !localHttp) {
    throw new InstallationError('configuration_invalid');
  }
  return redirectUri.href;
}

function normalizeConfiguration(configuration) {
  const scopes = [...(configuration?.scopes || [])].map((scope) => String(scope).trim());
  const displayName = String(configuration?.displayName || '').trim();
  if (!scopes.length || scopes.some((scope) => !/^[A-Za-z][A-Za-z0-9.]+$/.test(scope))) {
    throw new InstallationError('configuration_invalid');
  }
  if (!displayName) {
    throw new InstallationError('configuration_invalid');
  }
  const azureManagementAppId = requireUuid(
    configuration?.azureManagementAppId,
    'configuration_invalid',
  );
  const azureManagementScope = String(configuration?.azureManagementScope || '').trim();
  if (
    azureManagementAppId !== AZURE_SERVICE_MANAGEMENT_APP_ID ||
    azureManagementScope !== 'user_impersonation'
  ) {
    throw new InstallationError('configuration_invalid');
  }
  return {
    clientId: requireUuid(configuration?.clientId, 'configuration_invalid'),
    applicationHomeTenantId: requireUuid(
      configuration?.applicationHomeTenantId,
      'configuration_invalid',
    ),
    displayName,
    redirectUri: requireRedirectUri(configuration?.redirectUri),
    scopes: [...new Set(scopes)],
    azureManagementAppId,
    azureManagementScope,
  };
}

function queryUrl(path, parameters) {
  const url = new URL(path, 'https://graph.microsoft.com/v1.0/');
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  return url.href;
}

async function graphRequest(fetchGraph, accessToken, url) {
  let response;
  try {
    response = await fetchGraph(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new InstallationError('graph_unavailable');
  }
  if (!response?.ok) {
    throw new InstallationError(
      response?.status === 401 || response?.status === 403
        ? 'verification_unauthorized'
        : 'graph_unavailable',
    );
  }
  try {
    return await response.json();
  } catch {
    throw new InstallationError('graph_unavailable');
  }
}

function scopeSet(value) {
  return new Set(String(value || '').split(/\s+/).filter(Boolean));
}

export function formatInstallationError(error) {
  const messages = {
    configuration_invalid: 'After Party installation is not configured correctly yet.',
    consent_cancelled: 'Permission approval was denied or cancelled. Use a tenant administrator and try again.',
    consent_failed: 'Microsoft could not approve the requested permissions. Try again with a tenant administrator.',
    consent_state_missing: 'The permission response is no longer linked to this browser session. Start again.',
    consent_state_mismatch: 'The permission response could not be verified. Start again from this page.',
    consent_state_expired: 'The permission request expired. Start it again from this page.',
    tenant_mismatch: 'Microsoft returned a different tenant. Sign out and choose the intended tenant administrator.',
    account_mismatch: 'The permission response belongs to a different account. Sign out and try again.',
    token_unavailable: 'Permission approval finished, but verification requires signing in again.',
    verification_unauthorized: 'The signed-in account cannot verify the tenant installation. Use a tenant administrator.',
    graph_unavailable: 'Microsoft Graph could not verify the installation. Try again shortly.',
    enterprise_app_missing: 'After Party was not found in this tenant after approval. Try the approval again.',
    enterprise_app_duplicate: 'More than one After Party enterprise application was found. Remove the unexpected duplicate before continuing.',
    enterprise_app_mismatch: 'The tenant enterprise application does not match the expected After Party identity.',
    graph_resource_invalid: 'Microsoft Graph could not be identified uniquely in this tenant.',
    azure_resource_invalid: 'Azure Service Management could not be identified uniquely in this tenant.',
    delegated_grant_missing: 'The required After Party permissions were not granted. Ask a tenant administrator to approve them again.',
    delegated_grant_partial: 'Only some After Party permissions were granted. Ask a tenant administrator to approve the complete list.',
    application_grant_unexpected: 'Unexpected app-only access was found. Remove it before connecting this tenant.',
  };
  return messages[error?.code] || 'After Party could not verify the tenant installation. Try again.';
}

export function createTenantInstallation({
  configuration,
  storage,
  navigate,
  replaceUrl,
  fetchGraph,
  randomUUID,
  now = () => Date.now(),
  delay = (milliseconds) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
  verificationAttempts = 6,
  verificationDelayMs = 2_000,
}) {
  const expected = normalizeConfiguration(configuration);
  if (
    !storage ||
    typeof navigate !== 'function' ||
    typeof replaceUrl !== 'function' ||
    typeof fetchGraph !== 'function' ||
    typeof randomUUID !== 'function' ||
    typeof delay !== 'function' ||
    !Number.isInteger(verificationAttempts) ||
    verificationAttempts < 1 ||
    !Number.isFinite(verificationDelayMs) ||
    verificationDelayMs < 0
  ) {
    throw new InstallationError('configuration_invalid');
  }

  function begin(account) {
    const tenantId = requireUuid(account?.tenantId, 'tenant_mismatch');
    const accountId = String(account?.homeAccountId || '').trim();
    const nonce = randomUUID();
    if (!accountId || !UUID_PATTERN.test(nonce)) {
      throw new InstallationError('configuration_invalid');
    }
    storage.setItem(
      CONSENT_STATE_KEY,
      JSON.stringify({ accountId, createdAt: now(), nonce, tenantId }),
    );
    const consentUrl = new URL(
      `https://login.microsoftonline.com/${tenantId}/v2.0/adminconsent`,
    );
    consentUrl.searchParams.set('client_id', expected.clientId);
    consentUrl.searchParams.set('scope', 'https://graph.microsoft.com/.default');
    consentUrl.searchParams.set('redirect_uri', expected.redirectUri);
    consentUrl.searchParams.set('state', nonce);
    navigate(consentUrl.href);
  }

  function consumeCallback(currentUrl) {
    const url = new URL(currentUrl);
    const isCallback = ['admin_consent', 'error', 'tenant'].some((name) =>
      url.searchParams.has(name),
    );
    if (!isCallback) {
      return null;
    }

    const serializedState = storage.getItem(CONSENT_STATE_KEY);
    storage.removeItem(CONSENT_STATE_KEY);
    replaceUrl(expected.redirectUri);
    if (!serializedState) {
      throw new InstallationError('consent_state_missing');
    }

    let state;
    try {
      state = JSON.parse(serializedState);
    } catch {
      throw new InstallationError('consent_state_mismatch');
    }
    if (!state?.nonce || url.searchParams.get('state') !== state.nonce) {
      throw new InstallationError('consent_state_mismatch');
    }
    const stateAge = now() - state.createdAt;
    if (
      !Number.isFinite(state.createdAt) ||
      stateAge < 0 ||
      stateAge > CONSENT_STATE_LIFETIME_MS
    ) {
      throw new InstallationError('consent_state_expired');
    }
    if (url.searchParams.has('error')) {
      throw new InstallationError(
        url.searchParams.get('error') === 'access_denied'
          ? 'consent_cancelled'
          : 'consent_failed',
      );
    }
    if (url.searchParams.get('admin_consent')?.toLowerCase() !== 'true') {
      throw new InstallationError('consent_failed');
    }
    const returnedTenantId = requireUuid(url.searchParams.get('tenant'), 'tenant_mismatch');
    if (returnedTenantId !== state.tenantId) {
      throw new InstallationError('tenant_mismatch');
    }
    return { accountId: state.accountId, tenantId: state.tenantId };
  }

  async function verifyOnce({ accessToken, callback }) {
    const servicePrincipals = await graphRequest(
      fetchGraph,
      accessToken,
      queryUrl('servicePrincipals', {
        '$filter': `appId eq '${expected.clientId}'`,
        '$select': 'id,appId,appOwnerOrganizationId,displayName,servicePrincipalType',
      }),
    );
    if (!Array.isArray(servicePrincipals.value)) {
      throw new InstallationError('graph_unavailable');
    }
    if (servicePrincipals.value?.length === 0) {
      throw new InstallationError('enterprise_app_missing');
    }
    if (servicePrincipals.value?.length !== 1) {
      throw new InstallationError('enterprise_app_duplicate');
    }
    const servicePrincipal = servicePrincipals.value[0];
    if (
      servicePrincipal.appId?.toLowerCase() !== expected.clientId ||
      servicePrincipal.appOwnerOrganizationId?.toLowerCase() !== expected.applicationHomeTenantId ||
      servicePrincipal.servicePrincipalType !== 'Application' ||
      servicePrincipal.displayName !== expected.displayName ||
      !UUID_PATTERN.test(servicePrincipal.id)
    ) {
      throw new InstallationError('enterprise_app_mismatch');
    }

    const graphPrincipals = await graphRequest(
      fetchGraph,
      accessToken,
      queryUrl('servicePrincipals', {
        '$filter': `appId eq '${MICROSOFT_GRAPH_APP_ID}'`,
        '$select': 'id,appId',
      }),
    );
    if (
      !Array.isArray(graphPrincipals.value) ||
      graphPrincipals.value?.length !== 1 ||
      graphPrincipals.value[0].appId?.toLowerCase() !== MICROSOFT_GRAPH_APP_ID ||
      !UUID_PATTERN.test(graphPrincipals.value[0].id)
    ) {
      throw new InstallationError('graph_resource_invalid');
    }
    const graphPrincipalId = graphPrincipals.value[0].id;

    const azurePrincipals = await graphRequest(
      fetchGraph,
      accessToken,
      queryUrl('servicePrincipals', {
        '$filter': `appId eq '${expected.azureManagementAppId}'`,
        '$select': 'id,appId',
      }),
    );
    if (
      !Array.isArray(azurePrincipals.value) ||
      azurePrincipals.value?.length !== 1 ||
      azurePrincipals.value[0].appId?.toLowerCase() !== expected.azureManagementAppId ||
      !UUID_PATTERN.test(azurePrincipals.value[0].id)
    ) {
      throw new InstallationError('azure_resource_invalid');
    }
    const azurePrincipalId = azurePrincipals.value[0].id;

    const grants = await graphRequest(
      fetchGraph,
      accessToken,
      queryUrl('oauth2PermissionGrants', {
        '$filter': `clientId eq '${servicePrincipal.id}'`,
        '$select': 'clientId,consentType,principalId,resourceId,scope',
      }),
    );
    if (!Array.isArray(grants.value)) {
      throw new InstallationError('graph_unavailable');
    }
    const adminGraphGrants = (grants.value || []).filter(
      (grant) =>
        grant.clientId === servicePrincipal.id &&
        grant.resourceId === graphPrincipalId &&
        grant.consentType === 'AllPrincipals' &&
        !grant.principalId,
    );
    if (adminGraphGrants.length !== 1) {
      throw new InstallationError('delegated_grant_missing');
    }
    const grantedScopes = scopeSet(adminGraphGrants[0].scope);
    if (expected.scopes.some((scope) => !grantedScopes.has(scope))) {
      throw new InstallationError('delegated_grant_partial');
    }
    const allowedScopes = new Set([...expected.scopes, ...BENIGN_IDENTITY_SCOPES]);
    if ([...grantedScopes].some((scope) => !allowedScopes.has(scope))) {
      throw new InstallationError('delegated_grant_partial');
    }
    const adminAzureGrants = (grants.value || []).filter(
      (grant) =>
        grant.clientId === servicePrincipal.id &&
        grant.resourceId === azurePrincipalId &&
        grant.consentType === 'AllPrincipals' &&
        !grant.principalId,
    );
    if (adminAzureGrants.length !== 1) {
      throw new InstallationError('delegated_grant_missing');
    }
    const grantedAzureScopes = scopeSet(adminAzureGrants[0].scope);
    if (
      grantedAzureScopes.size !== 1 ||
      !grantedAzureScopes.has(expected.azureManagementScope)
    ) {
      throw new InstallationError('delegated_grant_partial');
    }

    const appRoleAssignments = await graphRequest(
      fetchGraph,
      accessToken,
      queryUrl(`servicePrincipals/${servicePrincipal.id}/appRoleAssignments`, {
        '$select': 'id,appRoleId,resourceId',
      }),
    );
    if (!Array.isArray(appRoleAssignments.value)) {
      throw new InstallationError('graph_unavailable');
    }
    if (appRoleAssignments.value?.length) {
      throw new InstallationError('application_grant_unexpected');
    }

    return {
      status: 'installed',
      tenantId: callback.tenantId,
      servicePrincipalId: servicePrincipal.id,
      grantedScopes: [...expected.scopes, expected.azureManagementScope],
    };
  }

  async function verify({ account, accessToken, callback }) {
    const accountTenantId = requireUuid(account?.tenantId, 'tenant_mismatch');
    if (
      accountTenantId !== callback?.tenantId ||
      account?.homeAccountId !== callback?.accountId
    ) {
      throw new InstallationError('account_mismatch');
    }
    if (!accessToken) {
      throw new InstallationError('token_unavailable');
    }

    for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
      try {
        return await verifyOnce({ accessToken, callback });
      } catch (error) {
        if (
          attempt === verificationAttempts ||
          !RETRYABLE_VERIFICATION_CODES.has(error?.code)
        ) {
          throw error;
        }
        await delay(verificationDelayMs);
      }
    }
    throw new InstallationError('graph_unavailable');
  }

  async function verifyCurrent({ account, accessToken }) {
    const tenantId = requireUuid(account?.tenantId, 'tenant_mismatch');
    const accountId = String(account?.homeAccountId || '').trim();
    if (!accountId || !accessToken) {
      throw new InstallationError('token_unavailable');
    }
    return verifyOnce({
      accessToken,
      callback: { accountId, tenantId },
    });
  }

  return { begin, consumeCallback, verify, verifyCurrent };
}
