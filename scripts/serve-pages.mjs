import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { buildPages } from './build-pages.mjs';

const executeFile = promisify(execFile);
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

export async function resolveSourceIdentity(directory = process.cwd()) {
  try {
    const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
      executeFile('git', ['rev-parse', 'HEAD'], { cwd: directory }),
      executeFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: directory,
      }),
    ]);
    const commit = commitOutput.trim();
    return statusOutput.trim() ? `${commit}-dirty` : commit;
  } catch {
    return 'unknown-dirty';
  }
}

function send(response, statusCode, body = '') {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

export function createStaticServer(directory) {
  const root = path.resolve(directory);

  return http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      send(response, 400, 'Invalid URL');
      return;
    }

    const relativePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const filePath = path.resolve(root, relativePath.replace(/^\/+/, ''));
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      send(response, 404, 'Not found');
      return;
    }

    try {
      if (!(await stat(filePath)).isFile()) {
        send(response, 404, 'Not found');
        return;
      }
      const contents = await readFile(filePath);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': CONTENT_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream',
      });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (error.code === 'ENOENT') {
        send(response, 404, 'Not found');
        return;
      }
      throw error;
    }
  });
}

export async function servePages({
  source = 'site',
  output = 'dist',
  host = '127.0.0.1',
  port = Number(process.env.PORT ?? 4173),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }

  await buildPages({
    source,
    output,
    commit: await resolveSourceIdentity(),
    basePath: '/',
  });

  const server = createStaticServer(output);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`After Party is available at http://${host}:${actualPort}/`);
  return server;
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (import.meta.url === invokedPath) {
  await servePages();
}
