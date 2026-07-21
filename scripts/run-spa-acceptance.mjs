#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withDevelopmentLiveLock } from './development-live-lock.mjs';
import { createDevelopmentAdminClients, loadDevelopmentAdmin } from './development-admin.mjs';
import { defaultOperatorConfigPath } from './development-operator.mjs';
import { runSpaAcceptance, verifyReviewedConsentApplication } from './spa-acceptance.mjs';

export function parseArguments(values) {
  const result = {
    mode: 'prove',
    spaUrl: 'https://seanewest.github.io/after-party-labs/',
    operatorConfigPath: defaultOperatorConfigPath(),
    expectedCommit: undefined,
    expectedRuntimeImage: undefined,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--mode' && ['authenticate', 'prove'].includes(values[index + 1])) result.mode = values[++index];
    else if (value === '--url' && values[index + 1]) result.spaUrl = values[++index];
    else if (value === '--config' && values[index + 1]) result.operatorConfigPath = resolve(values[++index]);
    else if (value === '--commit' && /^[0-9a-f]{40}$/.test(values[index + 1] || '')) result.expectedCommit = values[++index];
    else if (value === '--runtime-image' && values[index + 1]) result.expectedRuntimeImage = values[++index];
    else throw new Error(`Unknown or incomplete argument: ${value}`);
  }
  if (result.mode === 'prove' && (!result.expectedCommit || !result.expectedRuntimeImage)) {
    throw new Error('Live proof requires --commit and --runtime-image with the exact published identities.');
  }
  return Object.freeze(result);
}

export async function main(values = process.argv.slice(2)) {
  const args = parseArguments(values);
  const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const result = await withDevelopmentLiveLock({
    task: `goal-20-spa-${args.mode}`,
    repositoryRoot,
    run: async ({ signal }) => {
      const administrator = await loadDevelopmentAdmin({ repositoryRoot });
      const { graph } = createDevelopmentAdminClients({ loaded: administrator });
      return runSpaAcceptance({
        ...args,
        repositoryRoot,
        signal,
        consentGuard: () => verifyReviewedConsentApplication(graph),
      });
    },
  });
  console.log(JSON.stringify({ status: result.evidence.status, artifactDirectory: result.artifactDirectory }, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
