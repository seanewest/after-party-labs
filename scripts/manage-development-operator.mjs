#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createOperatorContext,
  defaultOperatorConfigPath,
  prepareOperator,
  provisionOperator,
  revokeOperator,
  verifyOperator,
} from './development-operator.mjs';
import { withDevelopmentLiveLock } from './development-live-lock.mjs';

export function parseArguments(values) {
  const command = values[0];
  if (!['prepare', 'provision', 'status', 'revoke'].includes(command)) {
    throw new Error('Usage: npm run operator -- <prepare|provision|status|revoke> [--config PATH] [--administrator-config PATH]');
  }
  const result = { command, configPath: defaultOperatorConfigPath(), administratorConfigPath: undefined };
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === '--config' && values[index + 1]) result.configPath = resolve(values[++index]);
    else if (values[index] === '--administrator-config' && values[index + 1]) result.administratorConfigPath = resolve(values[++index]);
    else throw new Error(`Unknown or incomplete argument: ${values[index]}`);
  }
  return Object.freeze(result);
}

export async function main(values = process.argv.slice(2)) {
  const args = parseArguments(values);
  if (args.command === 'prepare') {
    const prepared = await prepareOperator({ directory: resolve(args.configPath, '..') });
    console.log(`Prepared encrypted operator certificate material outside Git: ${prepared.configPath}`);
    return prepared;
  }
  const context = await createOperatorContext({
    repositoryRoot: resolve(fileURLToPath(new URL('..', import.meta.url))),
    operatorConfigPath: args.configPath,
    administratorConfigPath: args.administratorConfigPath,
    allowExpiredOperator: args.command === 'revoke',
  });
  const checkpoint = (stage, status) => console.log(`[${stage}] ${status}`);
  const operation = args.command === 'provision'
    ? ({ signal } = {}) => provisionOperator(context, { checkpoint, signal })
    : args.command === 'revoke'
      ? ({ signal } = {}) => revokeOperator(context, { checkpoint, signal })
      : () => verifyOperator(context);
  const result = ['provision', 'revoke'].includes(args.command)
    ? await withDevelopmentLiveLock({
        task: `goal-20-operator-${args.command}`,
        repositoryRoot: resolve(fileURLToPath(new URL('..', import.meta.url))),
        administratorConfigPath: args.administratorConfigPath,
        run: operation,
      })
    : await operation();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
