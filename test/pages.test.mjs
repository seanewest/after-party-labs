import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';

import { buildPages } from '../scripts/build-pages.mjs';
import { createStaticServer, resolveSourceIdentity } from '../scripts/serve-pages.mjs';

const executeFile = promisify(execFile);

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'after-party-pages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the public app configuration contains only the reviewed SPA contract', async (t) => {
  const source = await readFile(new URL('../site/app-config.js', import.meta.url), 'utf8');
  const createScript = await readFile(
    new URL('../scripts/create-multitenant-app.sh', import.meta.url),
    'utf8',
  );
  const context = { location: { origin: 'http://127.0.0.1:4173' } };
  vm.runInNewContext(source, context);
  const config = JSON.parse(JSON.stringify(context.afterPartyConfig));

  assert.deepEqual(config, {
    applicationDisplayName: 'After Party',
    developerTenantId: '92563293-315c-4b6c-9b90-bcb47ee8c970',
    authentication: {
      clientId: '9edaa951-658e-4be2-9623-ee906cb604b2',
      authority: 'https://login.microsoftonline.com/organizations',
      redirectUri: 'http://127.0.0.1:4173/',
    },
    redirectUris: {
      production: 'https://seanewest.github.io/after-party-labs/',
      local: 'http://127.0.0.1:4173/',
    },
    microsoftGraphDelegatedScopes: [
      'User.Read',
      'Directory.ReadWrite.All',
      'Application.ReadWrite.All',
      'Group.ReadWrite.All',
      'User.ReadWrite.All',
      'RoleManagement.ReadWrite.Directory',
      'Policy.ReadWrite.ConditionalAccess',
      'AuditLog.Read.All',
      'Reports.Read.All',
      'Mail.ReadWrite',
      'Mail.Send',
      'Files.ReadWrite.All',
      'Sites.ReadWrite.All',
      'SecurityEvents.ReadWrite.All',
    ],
  });

  const serialized = JSON.stringify(config).toLowerCase();
  for (const forbiddenName of ['clientsecret', 'password', 'privatekey', 'certificate']) {
    assert.equal(serialized.includes(forbiddenName), false);
  }
  for (const scope of config.microsoftGraphDelegatedScopes) {
    assert.equal(createScript.includes(`'${scope}'`), true);
  }

  const productionContext = {
    location: { origin: 'https://seanewest.github.io' },
  };
  vm.runInNewContext(source, productionContext);
  assert.equal(
    productionContext.afterPartyConfig.authentication.redirectUri,
    'https://seanewest.github.io/after-party-labs/',
  );

  const output = await temporaryDirectory(t);
  await buildPages({
    source: fileURLToPath(new URL('../site', import.meta.url)),
    output,
    commit: 'config-test',
    basePath: '/after-party-labs/',
  });
  assert.equal(await readFile(path.join(output, 'app-config.js'), 'utf8'), source);
  assert.match(
    await readFile(path.join(output, 'installation.js'), 'utf8'),
    /createTenantInstallation/,
  );
  assert.match(
    await readFile(path.join(output, 'experiments.js'), 'utf8'),
    /mountExperimentCard/,
  );
});

test('the static page provides the shared experiment-card presentation', async () => {
  const index = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../site/styles.css', import.meta.url), 'utf8');

  assert.match(index, /id="experiments-heading"/);
  assert.match(index, /id="experiment-cards"/);
  assert.match(index, /what it can read or change/i);
  assert.match(styles, /\.experiment-card/);
  assert.match(styles, /\.experiment-result/);
  assert.match(styles, /\[data-effect="write"\]/);
});

test('the sign-in copy distinguishes identity consent from lab permissions', async () => {
  const index = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../site/app.js', import.meta.url), 'utf8');
  const configurationSource = await readFile(
    new URL('../site/app-config.js', import.meta.url),
    'utf8',
  );
  const context = { location: { origin: 'https://seanewest.github.io' } };
  vm.runInNewContext(configurationSource, context);

  assert.match(index, /may add an After Party enterprise application/i);
  assert.match(index, /does not grant the lab permissions/i);
  assert.match(index, /What approval allows/i);
  for (const scope of context.afterPartyConfig.microsoftGraphDelegatedScopes) {
    assert.match(index, new RegExp(`<code>${scope.replaceAll('.', '\\.')}</code>`));
  }
  assert.match(app, /No lab-management permissions have been granted yet/);
  assert.doesNotMatch(index, /does not install After Party or change your tenant/i);
});

test('buildPages stamps the exact commit and base path', async (t) => {
  const root = await temporaryDirectory(t);
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  await mkdir(source);
  await writeFile(
    path.join(source, 'index.html'),
    '<base href="__AFTER_PARTY_BASE_PATH__"><p>__AFTER_PARTY_COMMIT__</p>',
  );

  await buildPages({
    source,
    output,
    commit: 'abc123',
    basePath: '/after-party-labs/',
  });

  assert.equal(
    await readFile(path.join(output, 'index.html'), 'utf8'),
    '<base href="/after-party-labs/"><p>abc123</p>',
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(output, 'version.json'), 'utf8')),
    { commit: 'abc123', basePath: '/after-party-labs/' },
  );
  assert.match(
    await readFile(path.join(output, 'vendor', 'msal-browser.min.js'), 'utf8'),
    /@azure\/msal-browser v5\.17\.1/,
  );
  assert.match(
    await readFile(path.join(output, 'vendor', 'msal-browser.LICENSE.txt'), 'utf8'),
    /MIT License/,
  );
});

test('local source identity fails closed for modified and untracked files', async (t) => {
  const repository = await temporaryDirectory(t);
  const trackedFile = path.join(repository, 'site.html');
  await executeFile('git', ['init'], { cwd: repository });
  await writeFile(trackedFile, 'committed');
  await executeFile('git', ['add', 'site.html'], { cwd: repository });
  await executeFile(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'Initial site',
    ],
    { cwd: repository },
  );
  const { stdout } = await executeFile('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const commit = stdout.trim();

  assert.equal(await resolveSourceIdentity(repository), commit);

  await writeFile(trackedFile, 'modified');
  assert.equal(await resolveSourceIdentity(repository), `${commit}-dirty`);

  await writeFile(trackedFile, 'committed');
  await writeFile(path.join(repository, 'untracked.html'), 'untracked');
  assert.equal(await resolveSourceIdentity(repository), `${commit}-dirty`);
});

test('the local server serves the generated site without caching it', async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, 'index.html'), '<h1>After Party</h1>');
  const server = createStaticServer(root);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '<h1>After Party</h1>');
});

test('the local server does not expose files outside its site directory', async (t) => {
  const root = await temporaryDirectory(t);
  const site = path.join(root, 'site');
  await mkdir(site);
  await writeFile(path.join(site, 'index.html'), 'site');
  await writeFile(path.join(root, 'private.txt'), 'private');
  const server = createStaticServer(site);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/..%2Fprivate.txt`);

  assert.equal(response.status, 404);
});
