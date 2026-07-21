import { X509Certificate } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ClientCertificateCredential } from '@azure/identity';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const ARM_ORIGIN = 'https://management.azure.com';

export const DEVELOPMENT_ADMIN_CLIENT_ID = '7eb78f18-b49c-495c-a571-af03f06b58a9';
export const REQUIRED_GRAPH_APPLICATION_ROLES = Object.freeze([
  'AppRoleAssignment.ReadWrite.All',
  'Application.ReadWrite.All',
  'AuditLog.Read.All',
  'DelegatedPermissionGrant.ReadWrite.All',
  'Directory.ReadWrite.All',
  'Group.ReadWrite.All',
  'Organization.ReadWrite.All',
  'Policy.ReadWrite.AuthenticationMethod',
  'RoleManagement.ReadWrite.Directory',
  'User.ManageIdentities.All',
  'User.ReadWrite.All',
]);

export function defaultDevelopmentAdminConfigPath(environment = process.env) {
  return resolve(
    environment.XDG_CONFIG_HOME || resolve(homedir(), '.config'),
    'after-party',
    'graph-admin',
    'config.json',
  );
}

export function pathIsInside(parent, candidate) {
  const within = relative(resolve(parent), resolve(candidate));
  return within === '' || (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within));
}

async function assertPrivateFile(path, label) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${label} is not a file: ${path}`);
  if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
    throw new Error(`${label} must be owner-only: ${path}`);
  }
}

function decodeClaim(token, claim) {
  const segment = String(token || '').split('.')[1];
  if (!segment) throw new Error('The administrator access token is not a JWT.');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))[claim];
}

function validateAdministratorToken(token, config, resource) {
  if (String(decodeClaim(token, 'tid') || '').toLowerCase() !== config.tenantId.toLowerCase()) {
    throw new Error(`The ${resource} administrator token belongs to another tenant.`);
  }
  const applicationId = String(decodeClaim(token, 'appid') || decodeClaim(token, 'azp') || '');
  if (applicationId.toLowerCase() !== config.clientId.toLowerCase()) {
    throw new Error(`The ${resource} administrator token belongs to another application.`);
  }
  if (resource === 'Graph') {
    const roles = new Set(Array.isArray(decodeClaim(token, 'roles')) ? decodeClaim(token, 'roles') : []);
    const missing = REQUIRED_GRAPH_APPLICATION_ROLES.filter((role) => !roles.has(role));
    const unexpected = [...roles].filter((role) => !REQUIRED_GRAPH_APPLICATION_ROLES.includes(role));
    if (missing.length) throw new Error(`The Graph administrator is missing roles: ${missing.join(', ')}.`);
    if (unexpected.length) throw new Error(`The Graph administrator has unexpected roles: ${unexpected.sort().join(', ')}.`);
  }
}

export async function loadDevelopmentAdmin({
  configPath = defaultDevelopmentAdminConfigPath(),
  repositoryRoot = process.cwd(),
} = {}) {
  const resolvedConfigPath = resolve(configPath);
  const actualConfigPath = await realpath(resolvedConfigPath);
  if (pathIsInside(repositoryRoot, actualConfigPath)) {
    throw new Error('Development administrator configuration must be outside the repository.');
  }
  await assertPrivateFile(actualConfigPath, 'Development administrator configuration');
  const value = JSON.parse(await readFile(actualConfigPath, 'utf8'));
  for (const key of ['tenantId', 'clientId', 'subscriptionId']) {
    if (!UUID_PATTERN.test(value[key] || '')) throw new Error(`Administrator ${key} must be a GUID.`);
  }
  if (value.clientId.toLowerCase() !== DEVELOPMENT_ADMIN_CLIENT_ID) {
    throw new Error('The configured application is not After Party Development Admin.');
  }
  if (!isAbsolute(value.certificatePath || '')) throw new Error('Administrator certificate path must be absolute.');
  const certificatePath = await realpath(resolve(value.certificatePath));
  if (pathIsInside(repositoryRoot, certificatePath)) {
    throw new Error('Development administrator certificate must be outside the repository.');
  }
  await assertPrivateFile(certificatePath, 'Development administrator certificate');
  const source = await readFile(certificatePath, 'utf8');
  if (!/BEGIN (?:RSA )?PRIVATE KEY/.test(source) || !/BEGIN CERTIFICATE/.test(source)) {
    throw new Error('Development administrator PEM must contain a private key and certificate.');
  }
  const certificateBlock = source.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  const certificate = new X509Certificate(certificateBlock);
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('Development administrator certificate expired.');
  return Object.freeze({
    config: Object.freeze({
      tenantId: value.tenantId,
      tenantDomain: String(value.tenantDomain || '').toLowerCase(),
      clientId: value.clientId,
      subscriptionId: value.subscriptionId,
      certificatePath,
    }),
    configPath: actualConfigPath,
    certificate,
  });
}

function createRequestClient({ configuration, origin, scope, resource, credential, fetchImpl }) {
  async function accessToken() {
    const response = await credential.getToken(scope);
    if (!response?.token) throw new Error(`${resource} did not issue an administrator token.`);
    validateAdministratorToken(response.token, configuration, resource);
    return response.token;
  }

  async function request(path, options = {}) {
    const response = await fetchImpl(`${origin}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${await accessToken()}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      const error = new Error(body?.error?.message || text || `${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  return Object.freeze({ getToken: accessToken, request });
}

export function createDevelopmentAdminClients({ loaded, fetchImpl = fetch, credential } = {}) {
  if (!loaded?.config) throw new Error('Loaded development administrator configuration is required.');
  const activeCredential = credential || new ClientCertificateCredential(
    loaded.config.tenantId,
    loaded.config.clientId,
    loaded.config.certificatePath,
  );
  return Object.freeze({
    graph: createRequestClient({
      configuration: loaded.config,
      origin: GRAPH_ORIGIN,
      scope: `${GRAPH_ORIGIN}/.default`,
      resource: 'Graph',
      credential: activeCredential,
      fetchImpl,
    }),
    arm: createRequestClient({
      configuration: loaded.config,
      origin: ARM_ORIGIN,
      scope: `${ARM_ORIGIN}/.default`,
      resource: 'ARM',
      credential: activeCredential,
      fetchImpl,
    }),
  });
}
