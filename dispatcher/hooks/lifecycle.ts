#!/usr/bin/env node

import process from "node:process";

import { LifecycleHandler, parseLifecycleInput } from "../lifecycle.ts";
import { defaultDispatcherDatabasePath } from "../paths.ts";
import { DispatcherQueue } from "../queue.ts";
import { WorkerSessionStore } from "../session-store.ts";

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const input = parseLifecycleInput(
    JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
  );
  const databasePath = defaultDispatcherDatabasePath();
  const queue = new DispatcherQueue(databasePath);
  const sessions = new WorkerSessionStore(databasePath);
  try {
    const output = new LifecycleHandler(queue, sessions).handle(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally {
    sessions.close();
    queue.close();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`party lifecycle hook: ${message}\n`);
  process.exitCode = 1;
}
