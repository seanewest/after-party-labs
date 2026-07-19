import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeServer } from '../runtime/server.mjs';

test('the runtime server adapts JSON requests without exposing internal response data', async (t) => {
  const calls = [];
  const server = createRuntimeServer({
    handler: {
      async handle(request) {
        calls.push(request);
        return {
          status: request.path === '/operations' ? 200 : 404,
          body: request.path === '/operations'
            ? { status: 'authorized', operation: request.body.operation }
            : { status: 'rejected', code: 'operation_not_allowed' },
        };
      },
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const operation = await fetch(`http://127.0.0.1:${port}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ms-client-principal': 'principal' },
    body: JSON.stringify({ operation: 'runtime.status' }),
  });
  assert.equal(operation.status, 200);
  assert.deepEqual(await operation.json(), { status: 'authorized', operation: 'runtime.status' });
  assert.equal(calls[0].headers['x-ms-client-principal'], 'principal');

  const missing = await fetch(`http://127.0.0.1:${port}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { status: 'rejected', code: 'operation_not_allowed' });
});
