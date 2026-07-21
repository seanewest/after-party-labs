import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { createDevelopmentAdminClients, loadDevelopmentAdmin } from './development-admin.mjs';

const execute = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAPPING_PATTERN = /^X509:<SKI>[0-9A-F]{40}$/;
const CBA_POLICY_PATH = '/beta/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/X509Certificate';
const OWNER_ROLE_ID = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635';
const GLOBAL_ADMINISTRATOR_ROLE_ID = '62e90394-69f5-4237-9190-012177145e10';

export const DEVELOPMENT_BOUNDARY = Object.freeze({
  tenantId: '92563293-315c-4b6c-9b90-bcb47ee8c970',
  tenantDomain: 'corywest.onmicrosoft.com',
  subscriptionId: '6d8ebd0e-017f-401e-950d-e5a35de93dc6',
  subscriptionName: 'Azure subscription 1',
  region: 'eastus',
});
export const DEVELOPMENT_OPERATOR = Object.freeze({
  alias: 'after-party-operator',
  displayName: 'After Party Development Operator',
  groupName: 'After Party Development Operator CBA',
});

export function defaultOperatorDirectory(environment = process.env) {
  return resolve(
    environment.XDG_CONFIG_HOME || resolve(homedir(), '.config'),
    'after-party',
    'spa-operator',
  );
}

export function defaultOperatorConfigPath(environment = process.env) {
  return resolve(defaultOperatorDirectory(environment), 'config.json');
}

function pathIsInside(parent, candidate) {
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

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function runOpenSsl(arguments_, run = execute) {
  try {
    return await run('openssl', arguments_, { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`OpenSSL failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function certificateMapping(output) {
  const identifier = String(output || '').split(/\r?\n/).map((line) => line.trim())
    .find((line) => /^(?:[0-9A-F]{2}:)+[0-9A-F]{2}$/i.test(line))
    ?.replaceAll(':', '').toUpperCase();
  if (!identifier || identifier.length !== 40) throw new Error('Operator certificate has no 20-byte SKI.');
  return `X509:<SKI>${identifier}`;
}

function filePaths(directory) {
  return Object.freeze({
    directory,
    config: resolve(directory, 'config.json'),
    state: resolve(directory, 'tenant-state.json'),
    caKey: resolve(directory, 'ca-key.pem'),
    caPassphrase: resolve(directory, 'ca-key-passphrase.txt'),
    caPem: resolve(directory, 'ca-certificate.pem'),
    caDer: resolve(directory, 'ca-certificate.cer'),
    operatorKey: resolve(directory, 'operator-key.pem'),
    operatorKeyPassphrase: resolve(directory, 'operator-key-passphrase.txt'),
    operatorCsr: resolve(directory, 'operator.csr'),
    operatorExtensions: resolve(directory, 'operator-extensions.cnf'),
    operatorPem: resolve(directory, 'operator-certificate.pem'),
    operatorDer: resolve(directory, 'operator-certificate.cer'),
    operatorPfx: resolve(directory, 'operator-certificate.pfx'),
    operatorPfxPassphrase: resolve(directory, 'operator-pfx-passphrase.txt'),
  });
}

export async function prepareOperator({
  directory = defaultOperatorDirectory(),
  now = new Date(),
  runOpenSslImpl = runOpenSsl,
} = {}) {
  const paths = filePaths(resolve(directory));
  try {
    await stat(paths.config);
    throw new Error(`Operator configuration already exists: ${paths.config}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  await writeFile(paths.caPassphrase, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  await writeFile(paths.operatorKeyPassphrase, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  await writeFile(paths.operatorPfxPassphrase, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  await runOpenSslImpl(['genpkey', '-algorithm', 'RSA', '-aes-256-cbc', '-pass', `file:${paths.caPassphrase}`, '-pkeyopt', 'rsa_keygen_bits:2048', '-out', paths.caKey]);
  await runOpenSslImpl(['req', '-x509', '-new', '-sha256', '-days', '30', '-key', paths.caKey, '-passin', `file:${paths.caPassphrase}`, '-subj', '/CN=After Party Development Operator CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash', '-out', paths.caPem]);
  await runOpenSslImpl(['x509', '-in', paths.caPem, '-outform', 'DER', '-out', paths.caDer]);
  await runOpenSslImpl(['genpkey', '-algorithm', 'RSA', '-aes-256-cbc', '-pass', `file:${paths.operatorKeyPassphrase}`, '-pkeyopt', 'rsa_keygen_bits:2048', '-out', paths.operatorKey]);
  await runOpenSslImpl(['req', '-new', '-key', paths.operatorKey, '-passin', `file:${paths.operatorKeyPassphrase}`, '-subj', `/CN=${DEVELOPMENT_OPERATOR.displayName}`, '-out', paths.operatorCsr]);
  const upn = `${DEVELOPMENT_OPERATOR.alias}@${DEVELOPMENT_BOUNDARY.tenantDomain}`;
  await writeFile(paths.operatorExtensions, [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=clientAuth',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid,issuer',
    `subjectAltName=email:${upn}`,
    '',
  ].join('\n'), { mode: 0o600 });
  await runOpenSslImpl(['x509', '-req', '-in', paths.operatorCsr, '-CA', paths.caPem, '-CAkey', paths.caKey, '-passin', `file:${paths.caPassphrase}`, '-CAcreateserial', '-days', '29', '-sha256', '-extfile', paths.operatorExtensions, '-out', paths.operatorPem]);
  await runOpenSslImpl(['x509', '-in', paths.operatorPem, '-outform', 'DER', '-out', paths.operatorDer]);
  await runOpenSslImpl(['pkcs12', '-export', '-inkey', paths.operatorKey, '-passin', `file:${paths.operatorKeyPassphrase}`, '-in', paths.operatorPem, '-certfile', paths.caPem, '-name', DEVELOPMENT_OPERATOR.displayName, '-out', paths.operatorPfx, '-passout', `file:${paths.operatorPfxPassphrase}`]);
  const ski = await runOpenSslImpl(['x509', '-in', paths.operatorPem, '-noout', '-ext', 'subjectKeyIdentifier']);
  const configuration = {
    version: 1,
    ...DEVELOPMENT_BOUNDARY,
    alias: DEVELOPMENT_OPERATOR.alias,
    displayName: DEVELOPMENT_OPERATOR.displayName,
    userPrincipalName: upn,
    groupName: DEVELOPMENT_OPERATOR.groupName,
    certificateUserId: certificateMapping(ski.stdout),
    caCertificatePath: paths.caDer,
    operatorCertificatePath: paths.operatorDer,
    operatorPfxPath: paths.operatorPfx,
    operatorPfxPassphrasePath: paths.operatorPfxPassphrase,
    statePath: paths.state,
    generatedUtc: now.toISOString(),
  };
  await writePrivateJson(paths.config, configuration);
  for (const [name, path] of Object.entries(paths)) {
    if (name !== 'directory') await chmod(path, 0o600).catch(() => {});
  }
  await chmod(paths.directory, 0o700);
  return Object.freeze({ configPath: paths.config, configuration: Object.freeze(configuration) });
}

export function validateOperatorConfiguration(value) {
  const config = value && typeof value === 'object' ? value : {};
  if (config.version !== 1) throw new Error('Operator configuration version is unsupported.');
  for (const [key, expected] of Object.entries(DEVELOPMENT_BOUNDARY)) {
    if (config[key] !== expected) throw new Error(`Operator configuration ${key} is outside the standing development boundary.`);
  }
  if (config.alias !== DEVELOPMENT_OPERATOR.alias || config.displayName !== DEVELOPMENT_OPERATOR.displayName || config.groupName !== DEVELOPMENT_OPERATOR.groupName) {
    throw new Error('Operator configuration does not identify the dedicated development operator.');
  }
  const expectedUpn = `${DEVELOPMENT_OPERATOR.alias}@${DEVELOPMENT_BOUNDARY.tenantDomain}`;
  if (String(config.userPrincipalName || '').toLowerCase() !== expectedUpn.toLowerCase()) {
    throw new Error('Operator UPN is outside the standing development boundary.');
  }
  if (!MAPPING_PATTERN.test(config.certificateUserId || '')) throw new Error('Operator certificate mapping is invalid.');
  for (const key of ['caCertificatePath', 'operatorCertificatePath', 'operatorPfxPath', 'operatorPfxPassphrasePath', 'statePath']) {
    if (!isAbsolute(config[key] || '')) throw new Error(`Operator ${key} must be absolute.`);
  }
  return Object.freeze({ ...config });
}

export async function loadOperatorConfiguration({
  configPath = defaultOperatorConfigPath(),
  repositoryRoot = process.cwd(),
  allowExpired = false,
} = {}) {
  const resolvedPath = resolve(configPath);
  const actualConfigPath = await realpath(resolvedPath);
  if (pathIsInside(repositoryRoot, actualConfigPath)) throw new Error('Operator configuration must be outside Git.');
  await assertPrivateFile(actualConfigPath, 'Operator configuration');
  const validated = validateOperatorConfiguration(JSON.parse(await readFile(actualConfigPath, 'utf8')));
  const custodyDirectory = dirname(actualConfigPath);
  if (!pathIsInside(custodyDirectory, validated.statePath)) throw new Error('Operator tenant state must stay inside the credential directory.');
  const actualPaths = {};
  for (const [key, label] of [
    ['caCertificatePath', 'Operator CA certificate'],
    ['operatorCertificatePath', 'Operator certificate'],
    ['operatorPfxPath', 'Operator PFX'],
    ['operatorPfxPassphrasePath', 'Operator PFX passphrase'],
  ]) {
    const actualPath = await realpath(validated[key]);
    if (pathIsInside(repositoryRoot, actualPath)) throw new Error(`${label} must be outside Git.`);
    if (!pathIsInside(custodyDirectory, actualPath)) throw new Error(`${label} must stay inside the credential directory.`);
    await assertPrivateFile(actualPath, label);
    actualPaths[key] = actualPath;
  }
  let statePath = resolve(validated.statePath);
  try { statePath = await realpath(statePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!pathIsInside(custodyDirectory, statePath)) throw new Error('Operator tenant state must stay inside the credential directory.');
  const config = Object.freeze({ ...validated, ...actualPaths, statePath });
  const [certificateSource, caSource] = await Promise.all([
    readFile(config.operatorCertificatePath),
    readFile(config.caCertificatePath),
  ]);
  const certificate = new X509Certificate(certificateSource);
  const caCertificate = new X509Certificate(caSource);
  if (Date.parse(certificate.validFrom) > Date.now() || (!allowExpired && Date.parse(certificate.validTo) <= Date.now())) {
    throw new Error('Operator certificate is not currently valid.');
  }
  if (!caCertificate.ca || !certificate.checkIssued(caCertificate) || !certificate.verify(caCertificate.publicKey)) {
    throw new Error('Operator certificate does not chain to the configured CBA root.');
  }
  const pfxCertificate = await runOpenSsl(['pkcs12', '-in', config.operatorPfxPath, '-clcerts', '-nokeys', '-passin', `file:${config.operatorPfxPassphrasePath}`]);
  if (new X509Certificate(pfxCertificate.stdout).fingerprint256 !== certificate.fingerprint256) {
    throw new Error('Operator PFX does not contain the configured operator certificate.');
  }
  return Object.freeze({ config, configPath: actualConfigPath, certificate, caCertificate });
}

function policyBody(policy) {
  return {
    '@odata.type': '#microsoft.graph.x509CertificateAuthenticationMethodConfiguration',
    state: policy.state,
    certificateUserBindings: policy.certificateUserBindings,
    authenticationModeConfiguration: policy.authenticationModeConfiguration,
    crlValidationConfiguration: policy.crlValidationConfiguration,
    includeTargets: policy.includeTargets,
    excludeTargets: policy.excludeTargets,
  };
}

function operatorPolicy(groupId) {
  return {
    '@odata.type': '#microsoft.graph.x509CertificateAuthenticationMethodConfiguration',
    state: 'enabled',
    certificateUserBindings: [{
      x509CertificateField: 'SubjectKeyIdentifier',
      userProperty: 'certificateUserIds',
      priority: 1,
      trustAffinityLevel: 'high',
    }],
    authenticationModeConfiguration: {
      x509CertificateAuthenticationDefaultMode: 'x509CertificateMultiFactor',
      x509CertificateDefaultRequiredAffinityLevel: 'high',
      rules: [],
    },
    crlValidationConfiguration: { state: 'disabled', exemptedCertificateAuthoritiesSubjectKeyIdentifiers: [] },
    includeTargets: [{ targetType: 'group', id: groupId, isRegistrationRequired: false }],
    excludeTargets: [],
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deterministicUuid(...parts) {
  const bytes = createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function graphCollection(graph, path) {
  const values = [];
  let next = path;
  while (next) {
    const page = await graph.request(next);
    values.push(...(page.value || []));
    next = page['@odata.nextLink']?.replace(/^https:\/\/graph\.microsoft\.com/i, '') || null;
  }
  return values;
}

async function waitFor(read, validate, { attempts = 12, delay = (attempt) => attempt * 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await read();
      if (validate(value)) return value;
      lastError = new Error('The expected tenant state has not propagated yet.');
    } catch (error) {
      lastError = error;
      if (error.status !== 404 && attempt === attempts) throw error;
    }
    if (attempt < attempts) await new Promise((resolveWait) => setTimeout(resolveWait, delay(attempt)));
  }
  throw lastError;
}

async function readState(path) {
  try {
    await assertPrivateFile(path, 'Operator tenant state');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function optionalResource(read) {
  try { return await read(); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

async function exactUser(graph, upn) {
  const filter = encodeURIComponent(`userPrincipalName eq '${upn.replaceAll("'", "''")}'`);
  const users = await graphCollection(graph, `/v1.0/users?$filter=${filter}&$select=id,displayName,userPrincipalName,accountEnabled,userType`);
  if (users.length > 1) throw new Error('More than one development operator matches the fixed UPN.');
  return users[0] || null;
}

async function exactGroup(graph, name) {
  const filter = encodeURIComponent(`displayName eq '${name.replaceAll("'", "''")}'`);
  const groups = await graphCollection(graph, `/v1.0/groups?$filter=${filter}&$select=id,displayName,description,securityEnabled,mailEnabled,groupTypes`);
  if (groups.length > 1) throw new Error('More than one development operator CBA group exists.');
  return groups[0] || null;
}

export async function createOperatorContext({
  repositoryRoot = process.cwd(),
  operatorConfigPath,
  administratorConfigPath,
  clients,
  allowExpiredOperator = false,
} = {}) {
  const [operator, administrator] = await Promise.all([
    loadOperatorConfiguration({ configPath: operatorConfigPath, repositoryRoot, allowExpired: allowExpiredOperator }),
    clients ? Promise.resolve(null) : loadDevelopmentAdmin({ configPath: administratorConfigPath, repositoryRoot }),
  ]);
  const activeClients = clients || createDevelopmentAdminClients({ loaded: administrator });
  if (administrator && administrator.config.tenantId.toLowerCase() !== operator.config.tenantId.toLowerCase()) {
    throw new Error('Operator and administrator belong to different tenants.');
  }
  if (administrator && administrator.config.subscriptionId.toLowerCase() !== operator.config.subscriptionId.toLowerCase()) {
    throw new Error('Operator and administrator target different subscriptions.');
  }
  return Object.freeze({ ...activeClients, operator });
}

export async function provisionOperator(context, { checkpoint = () => {}, signal } = {}) {
  const { graph, arm, operator } = context;
  const config = operator.config;
  signal?.throwIfAborted();
  let state = await readState(config.statePath);
  const [currentPolicy, trusts, existingUser, existingGroup] = await Promise.all([
    graph.request(CBA_POLICY_PATH),
    graph.request(`/v1.0/organization/${config.tenantId}/certificateBasedAuthConfiguration`),
    exactUser(graph, config.userPrincipalName),
    exactGroup(graph, config.groupName),
  ]);
  if (!state) {
    if (trusts.value?.length) throw new Error('Tenant already has an unrelated CBA trust; refusing to replace it.');
    if (currentPolicy.state !== 'disabled') throw new Error('Tenant CBA policy is already active; refusing to replace its targets.');
    if (existingGroup) throw new Error('An untracked development operator CBA group already exists.');
    if (existingUser) throw new Error('An untracked development operator user already exists.');
    state = {
      version: 1,
      tenantId: config.tenantId,
      subscriptionId: config.subscriptionId,
      baselinePolicy: policyBody(currentPolicy),
      createdUtc: new Date().toISOString(),
      userId: null,
      groupId: null,
      trustId: null,
      directoryRoleAssignmentId: null,
      ownerRoleAssignmentId: null,
    };
    await writePrivateJson(config.statePath, state);
    checkpoint('rollback-snapshot', 'written');
  }
  if (state.tenantId !== config.tenantId || state.subscriptionId !== config.subscriptionId) {
    throw new Error('Operator tenant state is outside the standing development boundary.');
  }
  const trackedPolicy = state.groupId ? operatorPolicy(state.groupId) : null;
  if (!sameJson(policyBody(currentPolicy), state.baselinePolicy) && (!trackedPolicy || !sameJson(policyBody(currentPolicy), trackedPolicy))) {
    throw new Error('Tenant CBA policy drifted from both the captured baseline and tracked operator policy.');
  }

  signal?.throwIfAborted();
  let user = existingUser;
  if (!user) {
    user = await graph.request('/v1.0/users', {
      method: 'POST',
      body: JSON.stringify({
        accountEnabled: true,
        displayName: config.displayName,
        mailNickname: config.alias,
        userPrincipalName: config.userPrincipalName,
        passwordProfile: {
          forceChangePasswordNextSignIn: false,
          password: `${randomBytes(36).toString('base64url')}!aA1`,
        },
      }),
    });
    state.userId = user.id;
    await writePrivateJson(config.statePath, state);
    checkpoint('operator-user', 'created-with-discarded-random-password');
  }
  if (user.id !== state.userId || user.displayName !== config.displayName || !user.accountEnabled || user.userType !== 'Member') {
    throw new Error('Development operator user does not match the tracked enabled identity.');
  }

  signal?.throwIfAborted();
  let group = existingGroup;
  if (!group) {
    group = await graph.request('/v1.0/groups', {
      method: 'POST',
      body: JSON.stringify({
        displayName: config.groupName,
        description: 'Dedicated CBA target for the After Party development SPA operator.',
        mailEnabled: false,
        mailNickname: `after-party-spa-operator-${randomBytes(4).toString('hex')}`,
        securityEnabled: true,
        groupTypes: [],
      }),
    });
    state.groupId = group.id;
    await writePrivateJson(config.statePath, state);
    checkpoint('operator-group', 'created');
  }
  if (group.id !== state.groupId || group.displayName !== config.groupName || !group.securityEnabled || group.mailEnabled || group.groupTypes?.length) throw new Error('Development operator group does not match tracked state.');
  await waitFor(
    () => graph.request(`/v1.0/groups/${group.id}?$select=id`),
    (value) => value.id === group.id,
  );
  const members = await graphCollection(graph, `/v1.0/groups/${group.id}/members?$select=id`);
  if (members.some((member) => member.id !== user.id)) throw new Error('Development operator CBA group contains an unrelated member.');
  if (!members.some((member) => member.id === user.id)) {
    await graph.request(`/v1.0/groups/${group.id}/members/$ref`, {
      method: 'POST',
      body: JSON.stringify({ '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${user.id}` }),
    });
    checkpoint('operator-group', 'operator-added');
  }
  await waitFor(
    () => graphCollection(graph, `/v1.0/groups/${group.id}/members?$select=id`),
    (values) => values.length === 1 && values[0].id === user.id,
  );

  signal?.throwIfAborted();
  let trust = (trusts.value || []).find((item) => item.id === state.trustId);
  if (!trust) {
    if ((trusts.value || []).length) throw new Error('Tenant CBA trust drifted from the tracked operator trust.');
    trust = await graph.request(`/v1.0/organization/${config.tenantId}/certificateBasedAuthConfiguration`, {
      method: 'POST',
      body: JSON.stringify({
        certificateAuthorities: [{
          certificate: (await readFile(config.caCertificatePath)).toString('base64'),
          isRootAuthority: true,
        }],
      }),
    });
    state.trustId = trust.id;
    await writePrivateJson(config.statePath, state);
    checkpoint('operator-ca', 'trusted');
  }
  if (trust.certificateAuthorities?.length !== 1 || trust.certificateAuthorities[0].isRootAuthority !== true) throw new Error('Tracked operator CA trust is malformed.');
  const trackedCa = new X509Certificate(Buffer.from(trust.certificateAuthorities[0].certificate, 'base64'));
  if (trackedCa.fingerprint256 !== operator.caCertificate.fingerprint256) throw new Error('Tracked operator CA trust does not match external custody.');

  signal?.throwIfAborted();
  const liveUser = await graph.request(`/beta/users/${user.id}?$select=id,authorizationInfo`);
  const mappings = liveUser.authorizationInfo?.certificateUserIds || [];
  if (mappings.some((mapping) => mapping !== config.certificateUserId)) throw new Error('Development operator has an unrelated certificate mapping.');
  if (!mappings.includes(config.certificateUserId)) {
    if (mappings.length) throw new Error('Development operator has an unrelated certificate mapping.');
    await graph.request(`/beta/users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ authorizationInfo: { certificateUserIds: [config.certificateUserId] } }),
    });
    checkpoint('operator-certificate', 'mapped');
  }
  await waitFor(
    () => graph.request(`/beta/users/${user.id}?$select=id,authorizationInfo`),
    (value) => sameJson(value.authorizationInfo?.certificateUserIds || [], [config.certificateUserId]),
  );
  await graph.request(CBA_POLICY_PATH, { method: 'PATCH', body: JSON.stringify(operatorPolicy(group.id)) });
  checkpoint('operator-cba-policy', 'enabled');

  signal?.throwIfAborted();
  const directoryAssignments = await graphCollection(graph, `/v1.0/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`principalId eq '${user.id}' and roleDefinitionId eq '${GLOBAL_ADMINISTRATOR_ROLE_ID}'`)}`);
  let directoryAssignment = directoryAssignments[0];
  if (directoryAssignments.length > 1) throw new Error('Development operator has duplicate Global Administrator assignments.');
  if (!directoryAssignment) {
    directoryAssignment = await graph.request('/v1.0/roleManagement/directory/roleAssignments', {
      method: 'POST',
      body: JSON.stringify({
        principalId: user.id,
        roleDefinitionId: GLOBAL_ADMINISTRATOR_ROLE_ID,
        directoryScopeId: '/',
      }),
    });
    checkpoint('operator-directory-role', 'global-administrator-assigned');
  }
  state.directoryRoleAssignmentId = directoryAssignment.id;
  await writePrivateJson(config.statePath, state);

  signal?.throwIfAborted();
  const subscriptionScope = `/subscriptions/${config.subscriptionId}`;
  const ownerDefinition = `${subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/${OWNER_ROLE_ID}`;
  const ownerAssignmentId = deterministicUuid(config.tenantId, config.subscriptionId, user.id, OWNER_ROLE_ID);
  state.ownerRoleAssignmentId = ownerAssignmentId;
  await writePrivateJson(config.statePath, state);
  await arm.request(`${subscriptionScope}/providers/Microsoft.Authorization/roleAssignments/${ownerAssignmentId}?api-version=2022-04-01`, {
    method: 'PUT',
    body: JSON.stringify({ properties: { principalId: user.id, principalType: 'User', roleDefinitionId: ownerDefinition } }),
  });
  checkpoint('operator-azure-role', 'subscription-owner-assigned');

  return verifyOperator(context);
}

export async function verifyOperator(context) {
  const { graph, arm, operator } = context;
  const config = operator.config;
  const state = await readState(config.statePath);
  if (!state || !UUID_PATTERN.test(state.userId || '') || !UUID_PATTERN.test(state.groupId || '') || !UUID_PATTERN.test(state.trustId || '')) {
    throw new Error('Operator tenant state is incomplete.');
  }
  const subscriptionScope = `/subscriptions/${config.subscriptionId}`;
  const [user, group, members, trust, policy, directoryAssignments, ownerAssignment] = await Promise.all([
    graph.request(`/beta/users/${state.userId}?$select=id,displayName,userPrincipalName,accountEnabled,userType,authorizationInfo`),
    graph.request(`/v1.0/groups/${state.groupId}?$select=id,displayName,securityEnabled,mailEnabled,groupTypes`),
    graphCollection(graph, `/v1.0/groups/${state.groupId}/members?$select=id,userPrincipalName`),
    graph.request(`/v1.0/organization/${config.tenantId}/certificateBasedAuthConfiguration/${state.trustId}`),
    graph.request(CBA_POLICY_PATH),
    graphCollection(graph, `/v1.0/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`principalId eq '${state.userId}' and roleDefinitionId eq '${GLOBAL_ADMINISTRATOR_ROLE_ID}'`)}`),
    arm.request(`${subscriptionScope}/providers/Microsoft.Authorization/roleAssignments/${state.ownerRoleAssignmentId}?api-version=2022-04-01`),
  ]);
  if (user.displayName !== config.displayName || String(user.userPrincipalName).toLowerCase() !== config.userPrincipalName.toLowerCase() || !user.accountEnabled || user.userType !== 'Member') throw new Error('Operator identity verification failed.');
  if (members.length !== 1 || members[0].id !== user.id) throw new Error('Operator CBA group is not exclusive.');
  if (group.displayName !== config.groupName || !group.securityEnabled || group.mailEnabled || group.groupTypes?.length) throw new Error('Operator CBA group verification failed.');
  if (trust.certificateAuthorities?.length !== 1 || trust.certificateAuthorities[0].isRootAuthority !== true) throw new Error('Operator CBA trust verification failed.');
  const uploaded = new X509Certificate(Buffer.from(trust.certificateAuthorities[0].certificate, 'base64'));
  if (uploaded.fingerprint256 !== operator.caCertificate.fingerprint256) throw new Error('Uploaded CBA root differs from external operator CA.');
  if (!sameJson(user.authorizationInfo?.certificateUserIds || [], [config.certificateUserId])) throw new Error('Operator certificate mapping is not exclusive.');
  if (!sameJson(policyBody(policy), operatorPolicy(group.id))) throw new Error('Operator CBA policy verification failed.');
  if (directoryAssignments.length !== 1 || directoryAssignments[0].directoryScopeId !== '/') throw new Error('Operator Global Administrator assignment verification failed.');
  if (String(ownerAssignment.properties?.principalId).toLowerCase() !== user.id.toLowerCase() || !String(ownerAssignment.properties?.roleDefinitionId).toLowerCase().endsWith(`/${OWNER_ROLE_ID}`)) throw new Error('Operator subscription Owner verification failed.');
  return Object.freeze({
    status: 'ready',
    tenantId: config.tenantId,
    subscriptionId: config.subscriptionId,
    region: config.region,
    user: Object.freeze({ id: user.id, displayName: user.displayName, userPrincipalName: user.userPrincipalName }),
    certificate: Object.freeze({
      fingerprint256: operator.certificate.fingerprint256,
      validFrom: new Date(operator.certificate.validFrom).toISOString(),
      validTo: new Date(operator.certificate.validTo).toISOString(),
    }),
    authentication: Object.freeze({ method: 'certificate', affinity: 'high', groupId: group.id, trustId: trust.id }),
    directoryRole: 'Global Administrator',
    azureRole: Object.freeze({ name: 'Owner', scope: subscriptionScope }),
  });
}

export async function revokeOperator(context, { checkpoint = () => {}, signal } = {}) {
  const { graph, arm, operator } = context;
  const config = operator.config;
  const state = await readState(config.statePath);
  if (!state) return Object.freeze({ status: 'not-provisioned' });
  if (state.revokedUtc) return Object.freeze({ status: 'revoked', userId: state.userId });
  if (state.tenantId !== config.tenantId || state.subscriptionId !== config.subscriptionId) throw new Error('Tracked operator state is outside the standing development boundary.');

  // Remove broad privileges first. Each completed step is durable so a retry can safely resume.
  signal?.throwIfAborted();
  if (state.userId) {
    const assignments = await graphCollection(graph, `/v1.0/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`principalId eq '${state.userId}' and roleDefinitionId eq '${GLOBAL_ADMINISTRATOR_ROLE_ID}'`)}`);
    if (assignments.some((assignment) => assignment.principalId !== state.userId || assignment.roleDefinitionId !== GLOBAL_ADMINISTRATOR_ROLE_ID || assignment.directoryScopeId !== '/')) throw new Error('Tracked directory-role assignment ownership changed.');
    for (const assignment of assignments) await graph.request(`/v1.0/roleManagement/directory/roleAssignments/${assignment.id}`, { method: 'DELETE' });
    state.directoryRoleAssignmentId = null;
    await writePrivateJson(config.statePath, state);
    checkpoint('operator-directory-role', assignments.length ? 'removed' : 'already-absent');
  }
  signal?.throwIfAborted();
  if (state.userId) {
    const ownerRoleAssignmentId = state.ownerRoleAssignmentId || deterministicUuid(config.tenantId, config.subscriptionId, state.userId, OWNER_ROLE_ID);
    const path = `/subscriptions/${config.subscriptionId}/providers/Microsoft.Authorization/roleAssignments/${ownerRoleAssignmentId}?api-version=2022-04-01`;
    const assignment = await optionalResource(() => arm.request(path));
    if (assignment && (String(assignment.properties?.principalId).toLowerCase() !== String(state.userId).toLowerCase() || !String(assignment.properties?.roleDefinitionId).toLowerCase().endsWith(`/${OWNER_ROLE_ID}`))) throw new Error('Tracked subscription Owner assignment ownership changed.');
    if (assignment) await arm.request(path, { method: 'DELETE' });
    state.ownerRoleAssignmentId = null;
    await writePrivateJson(config.statePath, state);
    checkpoint('operator-azure-role', assignment ? 'removed' : 'already-absent');
  }

  signal?.throwIfAborted();
  if (state.userId && !state.userDisabled) {
    const user = await optionalResource(() => graph.request(`/beta/users/${state.userId}?$select=id,displayName,userPrincipalName,accountEnabled,userType,authorizationInfo`));
    if (user && (user.id !== state.userId || user.displayName !== config.displayName || String(user.userPrincipalName).toLowerCase() !== config.userPrincipalName.toLowerCase() || user.userType !== 'Member')) throw new Error('Tracked operator user ownership changed.');
    const certificateUserIds = (user?.authorizationInfo?.certificateUserIds || []).filter((value) => value !== config.certificateUserId);
    if (user) {
      await graph.request(`/beta/users/${state.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ accountEnabled: false, authorizationInfo: { certificateUserIds } }),
      });
    }
    state.userDisabled = true;
    await writePrivateJson(config.statePath, state);
    checkpoint('operator-user', user ? 'disabled-and-certificate-unmapped' : 'already-absent');
  }

  signal?.throwIfAborted();
  if (!state.policyRestored) {
    const policy = policyBody(await graph.request(CBA_POLICY_PATH));
    if (!sameJson(policy, state.baselinePolicy)) {
      if (!state.groupId || !sameJson(policy, operatorPolicy(state.groupId))) throw new Error('CBA policy drift prevents safe baseline restoration; broad operator privileges are already removed.');
      await graph.request(CBA_POLICY_PATH, { method: 'PATCH', body: JSON.stringify(state.baselinePolicy) });
    }
    state.policyRestored = true;
    await writePrivateJson(config.statePath, state);
    checkpoint('operator-cba-policy', 'baseline-restored');
  }

  signal?.throwIfAborted();
  if (state.trustId) {
    const path = `/v1.0/organization/${config.tenantId}/certificateBasedAuthConfiguration/${state.trustId}`;
    const trust = await optionalResource(() => graph.request(path));
    if (trust) {
      if (trust.certificateAuthorities?.length !== 1 || trust.certificateAuthorities[0].isRootAuthority !== true) throw new Error('Tracked operator CA trust ownership changed.');
      const certificate = new X509Certificate(Buffer.from(trust.certificateAuthorities[0].certificate, 'base64'));
      if (certificate.fingerprint256 !== operator.caCertificate.fingerprint256) throw new Error('Tracked operator CA trust no longer matches external custody.');
      await graph.request(path, { method: 'DELETE' });
    }
    state.trustId = null;
    await writePrivateJson(config.statePath, state);
    checkpoint('operator-ca', trust ? 'removed' : 'already-absent');
  }
  signal?.throwIfAborted();
  if (state.groupId) {
    const group = await optionalResource(() => graph.request(`/v1.0/groups/${state.groupId}?$select=id,displayName,description,securityEnabled,mailEnabled,groupTypes`));
    if (group && (group.id !== state.groupId || group.displayName !== config.groupName || !group.securityEnabled || group.mailEnabled || group.groupTypes?.length)) throw new Error('Tracked operator group ownership changed.');
    const members = group ? await graphCollection(graph, `/v1.0/groups/${state.groupId}/members?$select=id`) : [];
    if (members.some((member) => member.id !== state.userId)) throw new Error('Tracked operator group contains an unrelated member; refusing deletion.');
    if (group) await graph.request(`/v1.0/groups/${state.groupId}`, { method: 'DELETE' });
    state.groupId = null;
    await writePrivateJson(config.statePath, state);
    checkpoint('operator-group', group ? 'removed' : 'already-absent');
  }
  state.revokedUtc = new Date().toISOString();
  await writePrivateJson(config.statePath, state);
  return Object.freeze({ status: 'revoked', userId: state.userId });
}
