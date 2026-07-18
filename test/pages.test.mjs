import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPages } from '../scripts/build-pages.mjs';
import { createStaticServer } from '../scripts/serve-pages.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'after-party-pages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

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
