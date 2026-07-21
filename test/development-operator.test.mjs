import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  DEVELOPMENT_BOUNDARY,
  DEVELOPMENT_OPERATOR,
  loadOperatorConfiguration,
  prepareOperator,
  provisionOperator,
  revokeOperator,
  validateOperatorConfiguration,
} from '../scripts/development-operator.mjs';

const userId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const trustId = '33333333-3333-4333-8333-333333333333';
const directoryAssignmentId = '44444444-4444-4444-8444-444444444444';

async function prepared(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'after-party-operator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await prepareOperator({ directory });
  const operator = await loadOperatorConfiguration({ configPath: result.configPath, repositoryRoot: resolve(directory, 'repository') });
  return { directory, operator, result };
}

function fakeCloud(operator) {
  const data = {
    user: null,
    group: null,
    members: [],
    trust: null,
    policy: {
      '@odata.type': '#microsoft.graph.x509CertificateAuthenticationMethodConfiguration',
      state: 'disabled',
      certificateUserBindings: [],
      authenticationModeConfiguration: { x509CertificateAuthenticationDefaultMode: 'x509CertificateSingleFactor', x509CertificateDefaultRequiredAffinityLevel: 'low', rules: [] },
      crlValidationConfiguration: { state: 'disabled', exemptedCertificateAuthoritiesSubjectKeyIdentifiers: [] },
      includeTargets: [{ targetType: 'group', id: 'all_users', isRegistrationRequired: false }],
      excludeTargets: [],
    },
    mappings: [],
    directoryAssignment: null,
    ownerAssignment: null,
    calls: [],
  };
  const collection = (value) => ({ value: value ? [value] : [] });
  const graph = { request: async (path, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    data.calls.push({ resource: 'graph', method, path, body });
    if (path.includes('authenticationMethodConfigurations/X509Certificate')) {
      if (method === 'PATCH') { data.policy = structuredClone(body); return null; }
      return structuredClone(data.policy);
    }
    if (path.endsWith('/certificateBasedAuthConfiguration') && method === 'GET') return collection(data.trust);
    if (path.endsWith('/certificateBasedAuthConfiguration') && method === 'POST') {
      data.trust = { id: trustId, certificateAuthorities: body.certificateAuthorities };
      return data.trust;
    }
    if (path.endsWith(`/certificateBasedAuthConfiguration/${trustId}`) && method === 'GET') return data.trust;
    if (path.endsWith(`/certificateBasedAuthConfiguration/${trustId}`) && method === 'DELETE') { data.trust = null; return null; }
    if (path.startsWith('/v1.0/users?')) return collection(data.user);
    if (path === '/v1.0/users' && method === 'POST') {
      data.user = { id: userId, displayName: body.displayName, userPrincipalName: body.userPrincipalName, accountEnabled: true, userType: 'Member' };
      assert.equal(typeof body.passwordProfile.password, 'string');
      return data.user;
    }
    if (path.startsWith('/v1.0/groups?')) return collection(data.group);
    if (path === '/v1.0/groups' && method === 'POST') {
      data.group = { id: groupId, ...body };
      return data.group;
    }
    if (path.startsWith(`/v1.0/groups/${groupId}?`)) return data.group;
    if (path === `/v1.0/groups/${groupId}/members?$select=id`) return { value: [...data.members] };
    if (path === `/v1.0/groups/${groupId}/members?$select=id,userPrincipalName`) return { value: [...data.members] };
    if (path === `/v1.0/groups/${groupId}/members/$ref` && method === 'POST') { data.members = [{ id: userId, userPrincipalName: operator.config.userPrincipalName }]; return null; }
    if (path === `/v1.0/groups/${groupId}` && method === 'DELETE') { data.group = null; data.members = []; return null; }
    if (path.startsWith(`/beta/users/${userId}?`)) return { ...data.user, authorizationInfo: { certificateUserIds: [...data.mappings] } };
    if (path === `/beta/users/${userId}` && method === 'PATCH') {
      if (body.accountEnabled === false) data.user.accountEnabled = false;
      data.mappings = [...body.authorizationInfo.certificateUserIds];
      return null;
    }
    if (path.startsWith('/v1.0/roleManagement/directory/roleAssignments?')) return collection(data.directoryAssignment);
    if (path === '/v1.0/roleManagement/directory/roleAssignments' && method === 'POST') {
      data.directoryAssignment = { id: directoryAssignmentId, ...body };
      return data.directoryAssignment;
    }
    if (path === `/v1.0/roleManagement/directory/roleAssignments/${directoryAssignmentId}` && method === 'DELETE') { data.directoryAssignment = null; return null; }
    throw new Error(`Unexpected Graph request: ${method} ${path}`);
  } };
  const arm = { request: async (path, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    data.calls.push({ resource: 'arm', method, path, body });
    if (method === 'PUT') {
      data.ownerAssignment = { id: path.split('/').at(-1).split('?')[0], properties: body.properties };
      return data.ownerAssignment;
    }
    if (method === 'GET') return data.ownerAssignment;
    if (method === 'DELETE') { data.ownerAssignment = null; return null; }
    throw new Error(`Unexpected ARM request: ${method} ${path}`);
  } };
  return { data, context: { graph, arm, operator } };
}

test('operator configuration is fixed to the standing tenant, subscription, region, and dedicated identity', () => {
  const base = {
    version: 1,
    ...DEVELOPMENT_BOUNDARY,
    alias: DEVELOPMENT_OPERATOR.alias,
    displayName: DEVELOPMENT_OPERATOR.displayName,
    groupName: DEVELOPMENT_OPERATOR.groupName,
    userPrincipalName: `${DEVELOPMENT_OPERATOR.alias}@${DEVELOPMENT_BOUNDARY.tenantDomain}`,
    certificateUserId: `X509:<SKI>${'A'.repeat(40)}`,
    caCertificatePath: '/safe/ca.cer',
    operatorCertificatePath: '/safe/operator.cer',
    operatorPfxPath: '/safe/operator.pfx',
    operatorPfxPassphrasePath: '/safe/passphrase',
    statePath: '/safe/state.json',
  };
  assert.equal(validateOperatorConfiguration(base).region, 'eastus');
  assert.throws(() => validateOperatorConfiguration({ ...base, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), /standing development boundary/);
  assert.throws(() => validateOperatorConfiguration({ ...base, subscriptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), /standing development boundary/);
  assert.throws(() => validateOperatorConfiguration({ ...base, region: 'westus' }), /standing development boundary/);
  assert.throws(() => validateOperatorConfiguration({ ...base, alias: 'admin' }), /dedicated development operator/);
});

test('prepare writes encrypted owner-only credentials outside Git and load verifies their chain', async (t) => {
  const { directory, operator } = await prepared(t);
  assert.equal(operator.config.userPrincipalName, 'after-party-operator@corywest.onmicrosoft.com');
  assert.equal(operator.certificate.checkIssued(operator.caCertificate), true);
  assert.equal((await stat(directory)).mode & 0o077, 0);
  for (const name of ['config.json', 'ca-key.pem', 'operator-key.pem', 'operator-certificate.pfx', 'operator-pfx-passphrase.txt']) {
    assert.equal((await stat(resolve(directory, name))).mode & 0o077, 0);
  }
  assert.match(await readFile(resolve(directory, 'operator-key.pem'), 'utf8'), /BEGIN ENCRYPTED PRIVATE KEY/);
  await assert.rejects(() => loadOperatorConfiguration({ configPath: resolve(directory, 'config.json'), repositoryRoot: directory }), /outside Git/);
});

test('provision is idempotent and revoke removes only the tracked operator boundary', async (t) => {
  const { operator } = await prepared(t);
  const cloud = fakeCloud(operator);
  const first = await provisionOperator(cloud.context);
  assert.equal(first.status, 'ready');
  assert.equal(first.user.userPrincipalName, operator.config.userPrincipalName);
  assert.equal(first.directoryRole, 'Global Administrator');
  assert.equal(first.azureRole.scope, `/subscriptions/${DEVELOPMENT_BOUNDARY.subscriptionId}`);
  const writesAfterFirst = cloud.data.calls.filter((call) => call.method !== 'GET').length;
  const second = await provisionOperator(cloud.context);
  assert.equal(second.status, 'ready');
  const secondWrites = cloud.data.calls.slice().filter((call) => call.method !== 'GET').length - writesAfterFirst;
  assert.equal(secondWrites, 2, 'idempotent reconciliation only reasserts policy and deterministic Owner assignment');
  assert.deepEqual(cloud.data.mappings, [operator.config.certificateUserId]);
  assert.deepEqual(cloud.data.members.map(({ id }) => id), [userId]);
  assert.equal(cloud.data.policy.includeTargets[0].id, groupId);

  const revoked = await revokeOperator(cloud.context);
  assert.equal(revoked.status, 'revoked');
  assert.equal(cloud.data.user.accountEnabled, false);
  assert.deepEqual(cloud.data.mappings, []);
  assert.equal(cloud.data.group, null);
  assert.equal(cloud.data.trust, null);
  assert.equal(cloud.data.directoryAssignment, null);
  assert.equal(cloud.data.ownerAssignment, null);
  assert.equal(cloud.data.policy.state, 'disabled');
  assert.deepEqual(await revokeOperator(cloud.context), { status: 'revoked', userId });
});

test('revoke resumes from partial state and removes remaining privilege without requiring full readiness', async (t) => {
  const { operator } = await prepared(t);
  const cloud = fakeCloud(operator);
  await provisionOperator(cloud.context);
  cloud.data.directoryAssignment = null;
  cloud.data.ownerAssignment = null;
  const revoked = await revokeOperator(cloud.context);
  assert.equal(revoked.status, 'revoked');
  assert.equal(cloud.data.user.accountEnabled, false);
  assert.equal(cloud.data.trust, null);
  assert.equal(cloud.data.group, null);
});

test('revoke discovers deterministic broad roles after a create-success state-write crash', async (t) => {
  const { operator } = await prepared(t);
  const cloud = fakeCloud(operator);
  await provisionOperator(cloud.context);
  const state = JSON.parse(await readFile(operator.config.statePath, 'utf8'));
  state.directoryRoleAssignmentId = null;
  state.ownerRoleAssignmentId = null;
  await writeFile(operator.config.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await revokeOperator(cloud.context);
  assert.equal(cloud.data.directoryAssignment, null);
  assert.equal(cloud.data.ownerAssignment, null);
  assert.equal(cloud.data.user.accountEnabled, false);
});

test('provision refuses extra CBA membership or certificate mappings before reasserting privilege', async (t) => {
  const { operator } = await prepared(t);
  const cloud = fakeCloud(operator);
  await provisionOperator(cloud.context);
  cloud.data.members.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userPrincipalName: 'other@example.test' });
  await assert.rejects(() => provisionOperator(cloud.context), /unrelated member/);
  cloud.data.members = [{ id: userId, userPrincipalName: operator.config.userPrincipalName }];
  cloud.data.mappings.push(`X509:<SKI>${'B'.repeat(40)}`);
  await assert.rejects(() => provisionOperator(cloud.context), /unrelated certificate mapping/);
});
