#!/usr/bin/env node

import process from "node:process";

import {
  GitHubFeedbackPoller,
  GitHubFeedbackStore,
} from "./github-feedback.ts";
import {
  GitHubContinuationPoller,
  GitHubContinuationStore,
} from "./github-continuation.ts";
import { GhCliGitHubSource } from "./github-source.ts";
import { defaultDispatcherDatabasePath } from "./paths.ts";
import { DispatcherQueue } from "./queue.ts";

interface Options {
  owner: string;
  projectNumber: number;
  databasePath: string;
  perPage?: number;
  maxPages?: number;
  reviewCycleThreshold?: number;
  json: boolean;
}

export async function runGitHubPollerCli(
  argv = process.argv.slice(2),
): Promise<number> {
  if (argv.includes("help") || argv.includes("--help")) {
    process.stdout.write(helpText);
    return 0;
  }
  const options = parseOptions(argv);
  const queue = new DispatcherQueue(options.databasePath);
  const store = new GitHubFeedbackStore(options.databasePath);
  const continuationStore = new GitHubContinuationStore(options.databasePath);
  try {
    const source = new GhCliGitHubSource({
      owner: options.owner,
      projectNumber: options.projectNumber,
    });
    const poller = new GitHubFeedbackPoller(source, store, queue, {
      perPage: options.perPage,
      maxPages: options.maxPages,
      reviewCycleThreshold: options.reviewCycleThreshold,
    });
    const feedback = await poller.poll();
    const continuations = await new GitHubContinuationPoller(
      source,
      continuationStore,
      queue,
    ).poll();
    const result = { ...feedback, continuations };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `GitHub poll complete: feedback ${feedback.recorded} recorded, ` +
          `${feedback.queued} queued, ${feedback.ignored} ignored, ` +
          `${feedback.escalated} escalated; continuations ${continuations.inspected} inspected, ` +
          `${continuations.queued} queued, ${continuations.pending} pending, ` +
          `${continuations.failed} failed, ${continuations.escalated} escalated; ` +
          `${feedback.sourceFailures + continuations.sourceFailures} source failures.\n`,
      );
    }
    return feedback.sourceFailures + continuations.sourceFailures === 0 ? 0 : 2;
  } finally {
    continuationStore.close();
    store.close();
    queue.close();
  }
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument "${argument}".`);
    }
    const name = argument.slice(2);
    if (name === "json") {
      values.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option --${name} requires a value.`);
    }
    values.set(name, value);
    index += 1;
  }

  const owner = stringOption(values, "owner");
  const projectNumber = integerOption(values, "project");
  if (!owner) {
    throw new Error("Missing required option --owner.");
  }
  if (!projectNumber) {
    throw new Error("Missing required option --project.");
  }
  return {
    owner,
    projectNumber,
    databasePath:
      stringOption(values, "database") ?? defaultDispatcherDatabasePath(),
    perPage: integerOption(values, "per-page"),
    maxPages: integerOption(values, "max-pages"),
    reviewCycleThreshold: integerOption(values, "review-cycle-threshold"),
    json: values.get("json") === true,
  };
}

function stringOption(
  values: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = values.get(name);
  return typeof value === "string" ? value : undefined;
}

function integerOption(
  values: Map<string, string | true>,
  name: string,
): number | undefined {
  const value = stringOption(values, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Option --${name} must be a positive integer.`);
  }
  return parsed;
}

const helpText = `Usage: party-github-poller --owner LOGIN --project NUMBER [options]

Runs one bounded polling pass over active board Tasks, their linked pull
requests, and registered one-shot continuations. Invoke it again on a schedule;
durable SQLite state and source IDs make restart and overlapping passes safe.

Options:
  --database PATH                 Override the dispatcher SQLite path.
  --per-page NUMBER               GitHub page size (default: 100).
  --max-pages NUMBER              Safety limit per source (default: 100).
  --review-cycle-threshold NUMBER Escalate after this many change cycles (default: 3).
  --json                          Print machine-readable results.
`;

if (import.meta.main) {
  try {
    process.exitCode = await runGitHubPollerCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`party-github-poller: ${message}\n`);
    process.exitCode = 1;
  }
}
