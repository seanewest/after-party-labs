#!/usr/bin/env node

import process from "node:process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { validateLocalAppServerEndpoint } from "./app-server-client.ts";
import {
  inspectHookInstallation,
  installHooks,
  uninstallHooks,
} from "./hook-installation.ts";
import { defaultDispatcherDatabasePath } from "./paths.ts";
import { DispatcherQueue } from "./queue.ts";
import { parseAgentName } from "./registry.ts";
import { WorkerSessionStore } from "./session-store.ts";
import { SharedWorkerDeliveryPrototype } from "./shared-worker-prototype.ts";
import { TmuxWorkerTerminal } from "./tmux-runner.ts";
import {
  CodexExecTurnOutcomeSource,
  parseJsonLines,
  StructuredTurnOutcomeMonitor,
} from "./turn-outcome.ts";
import { DeliveryCoordinator } from "./worker-runner.ts";
import { FlockWorkerClientLock } from "./worker-lock.ts";

interface ParsedArguments {
  options: Map<string, string | true>;
  positionals: string[];
}

export async function runParty(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(argv);
  const [command, ...positionals] = parsed.positionals;
  if (!command || command === "help") {
    process.stdout.write(helpText);
    return command ? 0 : 1;
  }

  if (command === "hooks") {
    return runHookCommand(positionals);
  }

  const databasePath = option(parsed, "database") ?? defaultDispatcherDatabasePath();
  const queue = new DispatcherQueue(databasePath);
  const sessions = new WorkerSessionStore(databasePath);
  const terminal = new TmuxWorkerTerminal({ dispatcherDatabasePath: databasePath });
  const workerClientLock = new FlockWorkerClientLock(databasePath);
  try {
    switch (command) {
      case "configure": {
        const name = parseAgentName(requiredPositional(positionals, 0, "worker name"));
        const worktree = requiredPositional(positionals, 1, "absolute worktree path");
        const worker = sessions.configureWorker(name, worktree);
        queue.setWorkerAvailability(name, "asleep");
        process.stdout.write(`${worker.name}: ${worker.worktreePath}\n`);
        return 0;
      }
      case "agents": {
        const availability = new Map(
          queue.listWorkers().map((worker) => [worker.name, worker.availability]),
        );
        for (const worker of sessions.listWorkers()) {
          const session = worker.sessionId ?? "no saved Codex session";
          process.stdout.write(
            `${worker.name}: ${availability.get(worker.name)}; ${worker.worktreePath}; ${session}\n`,
          );
        }
        return 0;
      }
      case "agent": {
        const name = parseAgentName(requiredPositional(positionals, 0, "worker name"));
        const worker = sessions.requireWorker(name);
        const remoteEndpoint = option(parsed, "remote");
        if (remoteEndpoint) {
          const endpoint = validateLocalAppServerEndpoint(remoteEndpoint);
          const remoteTerminal = new TmuxWorkerTerminal({
            dispatcherDatabasePath: databasePath,
            remoteEndpoint: endpoint,
          });
          remoteTerminal.start(worker);
          remoteTerminal.attach(name);
          return 0;
        }
        const ownership = await workerClientLock.tryAcquire(name);
        if (!ownership) {
          throw new Error(
            `Worker ${name} already has an interactive or automated client.`,
          );
        }
        try {
          terminal.start(worker);
          terminal.attach(name);
        } finally {
          await ownership.release();
        }
        return 0;
      }
      case "shared-server": {
        const name = parseAgentName(requiredPositional(positionals, 0, "worker name"));
        const worker = sessions.requireWorker(name);
        const endpoint = validateLocalAppServerEndpoint(
          requiredOption(parsed, "listen"),
        );
        const ownership = await workerClientLock.tryAcquire(name);
        if (!ownership) {
          throw new Error(`Worker ${name} already has a Codex thread owner.`);
        }
        try {
          await runSharedAppServer(endpoint, worker.worktreePath);
        } finally {
          await ownership.release();
        }
        return 0;
      }
      case "shared-deliver": {
        const name = parseAgentName(requiredPositional(positionals, 0, "worker name"));
        const result = await new SharedWorkerDeliveryPrototype(queue, sessions, {
          endpoint: requiredOption(parsed, "remote"),
          recipient: name,
          consumer: option(parsed, "consumer"),
          leaseMs: integerOption(parsed, "lease-ms"),
          turnTimeoutMs: integerOption(parsed, "turn-timeout-ms"),
        }).deliverOnce();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.outcome === "failed" || result.outcome === "escalated" ? 1 : 0;
      }
      case "deliver": {
        const coordinator = coordinatorFor(
          parsed,
          queue,
          sessions,
          terminal,
          workerClientLock,
        );
        const result = await coordinator.deliverOnce();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.outcome === "failed" ? 1 : 0;
      }
      case "turn-events": {
        const messageId = requiredPositional(positionals, 0, "message ID");
        const monitor = new StructuredTurnOutcomeMonitor(queue, {
          messageId,
          reportedBy: requiredOption(parsed, "reported-by"),
          attemptNumber: requiredIntegerOption(parsed, "attempt"),
          streamId: requiredOption(parsed, "stream-id"),
          historyComplete: !booleanOption(parsed, "history-incomplete"),
          retryAfterMs: integerOption(parsed, "retry-after-ms"),
        });
        let result = null;
        for (const event of parseJsonLines(readFileSync(0, "utf8"))) {
          result = monitor.consume(event) ?? result;
        }
        if (!result) {
          throw new Error("The Codex event stream ended without a terminal turn outcome.");
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.outcome === "escalated" ? 2 : 0;
      }
      case "run": {
        const coordinator = coordinatorFor(
          parsed,
          queue,
          sessions,
          terminal,
          workerClientLock,
        );
        const interval = integerOption(parsed, "interval-ms") ?? 1_000;
        if (interval < 1) {
          throw new Error("--interval-ms must be positive.");
        }
        do {
          const result = await coordinator.deliverOnce();
          if (booleanOption(parsed, "once")) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return result.outcome === "failed" ? 1 : 0;
          }
          await delay(interval);
        } while (true);
      }
      default:
        throw new Error(`Unknown command "${command}". Run "party help".`);
    }
  } finally {
    sessions.close();
    queue.close();
  }
}

function runHookCommand(positionals: string[]): number {
  const action = requiredPositional(positionals, 0, "hooks action");
  const result =
    action === "install"
      ? installHooks()
      : action === "uninstall"
        ? uninstallHooks()
        : action === "status"
          ? inspectHookInstallation()
          : null;
  if (!result) {
    throw new Error(`Unknown hooks action "${action}". Use install, status, or uninstall.`);
  }
  process.stdout.write(
    `${result.status}: ${result.targetPath}\n${result.command ? `${result.command}\n` : ""}`,
  );
  return result.status === "conflict" || result.status === "update_available" ? 1 : 0;
}

function coordinatorFor(
  parsed: ParsedArguments,
  queue: DispatcherQueue,
  sessions: WorkerSessionStore,
  terminal: TmuxWorkerTerminal,
  workerClientLock: FlockWorkerClientLock,
): DeliveryCoordinator {
  return new DeliveryCoordinator(queue, sessions, terminal, {
    consumer: option(parsed, "consumer"),
    leaseMs: integerOption(parsed, "lease-ms"),
    startupTimeoutMs: integerOption(parsed, "startup-timeout-ms"),
    receiptTimeoutMs: integerOption(parsed, "receipt-timeout-ms"),
    pollMs: integerOption(parsed, "poll-ms"),
    turnOutcomeSource: new CodexExecTurnOutcomeSource(queue),
    workerClientLock,
  });
}

function parseArguments(argv: string[]): ParsedArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (name === "once" || name === "history-incomplete") {
      options.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option --${name} requires a value.`);
    }
    options.set(name, value);
    index += 1;
  }
  return { options, positionals };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function booleanOption(parsed: ParsedArguments, name: string): boolean {
  return parsed.options.get(name) === true;
}

function integerOption(parsed: ParsedArguments, name: string): number | undefined {
  const value = option(parsed, name);
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Option --${name} must be a non-negative integer.`);
  }
  return number;
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = option(parsed, name);
  if (!value) {
    throw new Error(`Missing required option --${name}.`);
  }
  return value;
}

function requiredIntegerOption(parsed: ParsedArguments, name: string): number {
  const value = integerOption(parsed, name);
  if (value === undefined) {
    throw new Error(`Missing required option --${name}.`);
  }
  return value;
}

function requiredPositional(values: string[], index: number, label: string): string {
  const value = values[index];
  if (!value) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runSharedAppServer(endpoint: string, cwd: string): Promise<void> {
  const child = spawn("codex", ["app-server", "--listen", endpoint], {
    cwd,
    stdio: "inherit",
  });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  if (exit.code !== 0) {
    const label = exit.signal ? `signal ${exit.signal}` : `exit ${String(exit.code)}`;
    throw new Error(`Shared Codex app-server ended with ${label}.`);
  }
}

const helpText = `Usage: party [options] <command>

Commands:
  hooks install|status|uninstall
  configure NAME ABSOLUTE_WORKTREE_PATH
  agents
  shared-server NAME --listen ws://127.0.0.1:PORT
  agent NAME [--remote ws://127.0.0.1:PORT]
  shared-deliver NAME --remote ws://127.0.0.1:PORT [--turn-timeout-ms NUMBER]
  deliver [runner options]
  turn-events MESSAGE_ID --reported-by NAME --attempt NUMBER --stream-id ID
    [--retry-after-ms NUMBER] [--history-incomplete] < codex-events.jsonl
  run [--once] [--interval-ms NUMBER] [runner options]

Runner options:
  --consumer ID
  --lease-ms NUMBER
  --startup-timeout-ms NUMBER
  --receipt-timeout-ms NUMBER
  --poll-ms NUMBER

Global options:
  --database PATH   Override PARTY_DISPATCHER_DB and the default state path.

"party agent NAME" hides tmux while preserving the normal interactive Codex TUI.
Queued deliver/run work waits for an attached TUI, then resumes the same saved session
as its sole client through structured Codex JSON events. The next agent attach resumes
that session with the queued turn visible.
`;

if (import.meta.main) {
  try {
    process.exitCode = await runParty();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`party: ${message}\n`);
    process.exitCode = 1;
  }
}
