#!/usr/bin/env node

import process from "node:process";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { validateLocalAppServerEndpoint } from "./app-server-client.ts";
import {
  GoalContextStore,
  parseGoalReference,
  type GoalContextRecord,
} from "./goal-context.ts";
import { GoalEventDelivery } from "./goal-event-delivery.ts";
import { GoalGateway } from "./goal-gateway.ts";
import {
  GhProjectGoalSource,
  GoalGitHubPoller,
  type BoardGoal,
} from "./goal-github.ts";
import {
  inspectGoalRuntime,
  runtimeLogs,
  startGoalRuntime,
  stopGoalRuntime,
} from "./goal-runtime.ts";
import {
  inspectHookInstallation,
  installHooks,
  uninstallHooks,
} from "./hook-installation.ts";
import { defaultDispatcherDatabasePath } from "./paths.ts";
import { DispatcherQueue } from "./queue.ts";
import { parseAgentName } from "./registry.ts";
import { WorkerSessionStore } from "./session-store.ts";
import {
  controlDispatcherService,
  dispatcherServiceLogs,
  dispatcherServiceStatus,
  installDispatcherService,
  uninstallDispatcherService,
} from "./service.ts";
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
  if (command === "goal") {
    return runGoalCommand(positionals, parsed, databasePath);
  }
  if (command === "goal-gateway") {
    return runGoalGateway(positionals, parsed, databasePath);
  }
  if (command === "service") {
    return runServiceCommand(positionals, parsed, databasePath);
  }
  if (command === "run" && option(parsed, "owner") && option(parsed, "project")) {
    return runGoalLoop(parsed, databasePath);
  }

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

function runServiceCommand(
  positionals: string[],
  parsed: ParsedArguments,
  databasePath: string,
): number {
  const action = requiredPositional(positionals, 0, "service action");
  if (action === "install") {
    const result = installDispatcherService({
      owner: requiredOption(parsed, "owner"),
      projectNumber: requiredIntegerOption(parsed, "project"),
      checkout: option(parsed, "checkout") ?? process.cwd(),
      databasePath,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.active === "active" ? 0 : 1;
  }
  if (action === "uninstall") {
    process.stdout.write(`${JSON.stringify(uninstallDispatcherService(), null, 2)}\n`);
    return 0;
  }
  if (action === "status") {
    const result = dispatcherServiceStatus();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.active === "active" ? 0 : 1;
  }
  if (action === "logs") {
    process.stdout.write(
      `${dispatcherServiceLogs(integerOption(parsed, "lines") ?? 100)}\n`,
    );
    return 0;
  }
  if (["start", "stop", "restart"].includes(action)) {
    const result = controlDispatcherService(
      action as "start" | "stop" | "restart",
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return action === "stop" || result.active === "active" ? 0 : 1;
  }
  throw new Error(`Unknown service action "${action}".`);
}

async function runGoalLoop(
  parsed: ParsedArguments,
  databasePath: string,
): Promise<number> {
  const owner = requiredOption(parsed, "owner");
  const projectNumber = requiredIntegerOption(parsed, "project");
  const checkout = option(parsed, "checkout") ?? process.cwd();
  const interval = integerOption(parsed, "interval-ms") ?? 5_000;
  if (interval < 1) {
    throw new Error("--interval-ms must be positive.");
  }
  do {
    const store = new GoalContextStore(databasePath);
    try {
      const source = new GhProjectGoalSource({ owner, projectNumber });
      const poller = new GoalGitHubPoller(source, store, {
        provision: (goal) => provisionGoal(goal, store, databasePath, checkout),
      });
      const github = await poller.poll();
      const deliveries: Array<{ goal: string; result: Record<string, unknown> }> = [];
      const delivery = new GoalEventDelivery(store, {
        consumer: option(parsed, "consumer"),
        turnTimeoutMs: integerOption(parsed, "turn-timeout-ms"),
      });
      for (let context of store.list()) {
        if (existsSync(context.worktreePath)) {
          context = store.updateRuntime(context.id, checkpoint(context.worktreePath));
        }
        const health = await inspectGoalRuntime(context.id, databasePath);
        if (
          context.state === "starting" &&
          (!health.appServerAlive || !health.gatewayAlive) &&
          Date.now() - context.updatedAt > 30_000
        ) {
          context = store.updateRuntime(context.id, {
            state: "error",
            appServerPid: null,
            gatewayPid: null,
            lastError: "stale runtime start recovered by dispatcher",
          });
        }
        if (["stopped", "human_needed"].includes(context.state)) {
          if (health.appServerAlive || health.gatewayAlive) {
            const desiredState = context.state;
            context = await stopGoalRuntime(context.id, databasePath);
            if (desiredState === "human_needed") {
              context = store.updateRuntime(context.id, { state: "human_needed" });
            }
          }
          continue;
        }
        if (
          ["running", "sleeping", "error"].includes(context.state) &&
          (!health.appServerAlive || !health.gatewayAlive)
        ) {
          try {
            context = await startGoalRuntime(context.id, { databasePath });
          } catch (error) {
            deliveries.push({
              goal: `${context.repository}#${context.issueNumber}`,
              result: {
                outcome: "failed" as const,
                error: error instanceof Error ? error.message : String(error),
              },
            });
            continue;
          }
        }
        store.recoverInterruptedEvents(context.id);
        if (booleanOption(parsed, "once")) {
          deliveries.push({
            goal: `${context.repository}#${context.issueNumber}`,
            result: await delivery.deliverOnce(context.id),
          });
        } else {
          void deliverInOwnStore(databasePath, context.id, {
            consumer: option(parsed, "consumer"),
            turnTimeoutMs: integerOption(parsed, "turn-timeout-ms"),
          });
        }
      }
      const result = { github, deliveries };
      if (booleanOption(parsed, "once")) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return github.failures.length > 0 || deliveries.some(
          (value) => value.result.outcome === "failed",
        ) ? 1 : 0;
      }
    } finally {
      store.close();
    }
    await delay(interval);
  } while (true);
}

async function deliverInOwnStore(
  databasePath: string,
  contextId: string,
  options: { consumer?: string; turnTimeoutMs?: number },
): Promise<void> {
  const store = new GoalContextStore(databasePath);
  try {
    await new GoalEventDelivery(store, options).deliverOnce(contextId);
  } catch (error) {
    process.stderr.write(
      `Goal event delivery ${contextId} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    store.close();
  }
}

async function provisionGoal(
  goal: BoardGoal,
  store: GoalContextStore,
  databasePath: string,
  checkout: string,
): Promise<GoalContextRecord> {
  const localRepository = git(checkout, ["config", "--get", "remote.origin.url"]);
  if (!localRepository.toLowerCase().includes(goal.repository.toLowerCase())) {
    throw new Error(
      `Goal ${goal.repository} is not available from checkout ${checkout}.`,
    );
  }
  const worktree = join(
    dirname(databasePath),
    "worktrees",
    goal.repository.replaceAll("/", "-"),
    String(goal.issueNumber),
  );
  const branch = `agent/goal-${goal.issueNumber}-context`;
  if (!existsSync(worktree)) {
    mkdirSync(dirname(worktree), { recursive: true, mode: 0o700 });
    let branchExists = true;
    try {
      execFileSync(
        "git",
        ["-C", checkout, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { stdio: "ignore" },
      );
    } catch {
      branchExists = false;
    }
    if (branchExists) {
      execFileSync("git", ["-C", checkout, "worktree", "add", worktree, branch], {
        stdio: "pipe",
      });
    } else {
      execFileSync(
        "git",
        ["-C", checkout, "worktree", "add", "-b", branch, worktree, "origin/main"],
        { stdio: "pipe" },
      );
    }
  }
  const context = store.createOrGet({
    repository: goal.repository,
    issueNumber: goal.issueNumber,
    worktreePath: worktree,
    branch,
  });
  store.updateRuntime(context.id, checkpoint(worktree));
  return startGoalRuntime(context.id, { databasePath });
}

async function runGoalCommand(
  positionals: string[],
  parsed: ParsedArguments,
  databasePath: string,
): Promise<number> {
  const action = requiredPositional(positionals, 0, "goal action");
  const referenceValue = positionals[1];
  const store = new GoalContextStore(databasePath);
  try {
    if (action === "status" && !referenceValue) {
      process.stdout.write(`${JSON.stringify(store.list().map(runtimeSummary), null, 2)}\n`);
      return 0;
    }
    const reference = parseGoalReference(
      requiredPositional(positionals, 1, "goal reference"),
    );
    if (action === "start") {
      const worktree = option(parsed, "worktree") ?? process.cwd();
      const branch = option(parsed, "branch") ?? git(worktree, ["branch", "--show-current"]);
      const context = store.createOrGet({
        ...reference,
        worktreePath: worktree,
        branch,
        threadId: option(parsed, "thread-id") ?? null,
      });
      store.updateRuntime(context.id, checkpoint(worktree));
      store.close();
      const running = await startGoalRuntime(context.id, {
        databasePath,
        appPort: integerOption(parsed, "app-port"),
        gatewayPort: integerOption(parsed, "gateway-port"),
        startupTimeoutMs: integerOption(parsed, "startup-timeout-ms"),
      });
      process.stdout.write(`${JSON.stringify(runtimeSummary(running), null, 2)}\n`);
      return 0;
    }
    const context = store.requireByGoal(reference);
    if (action === "status") {
      process.stdout.write(
        `${JSON.stringify(await inspectGoalRuntime(context.id, databasePath), null, 2)}\n`,
      );
      return 0;
    }
    if (action === "stop") {
      store.updateRuntime(context.id, checkpoint(context.worktreePath));
      store.close();
      process.stdout.write(
        `${JSON.stringify(runtimeSummary(await stopGoalRuntime(context.id, databasePath)), null, 2)}\n`,
      );
      return 0;
    }
    if (action === "recover") {
      if (existsSync(context.worktreePath)) {
        const branch = git(context.worktreePath, ["branch", "--show-current"]);
        if (branch !== context.branch) {
          throw new Error(
            `Goal worktree branch changed from ${context.branch} to ${branch}; human reconciliation is required.`,
          );
        }
        store.updateRuntime(context.id, checkpoint(context.worktreePath));
      } else {
        reconstructGoalWorktree(context, option(parsed, "checkout") ?? process.cwd());
      }
      store.close();
      try {
        await stopGoalRuntime(context.id, databasePath);
      } catch {
        // A dead or already-reconciled process is expected during recovery.
      }
      const recovered = await startGoalRuntime(context.id, {
        databasePath,
        appPort: integerOption(parsed, "app-port"),
        gatewayPort: integerOption(parsed, "gateway-port"),
        startupTimeoutMs: integerOption(parsed, "startup-timeout-ms"),
      });
      process.stdout.write(`${JSON.stringify(runtimeSummary(recovered), null, 2)}\n`);
      return 0;
    }
    if (action === "open") {
      if (!context.contextUrl) {
        throw new Error("Goal context has no browser URL; start or recover it first.");
      }
      process.stdout.write(`${context.contextUrl}\n`);
      return 0;
    }
    if (action === "inspect") {
      process.stdout.write(
        `${JSON.stringify({
          ...await inspectGoalRuntime(context.id, databasePath),
          events: store.listEvents(context.id),
        }, null, 2)}\n`,
      );
      return 0;
    }
    if (action === "logs") {
      const paths = runtimeLogs(databasePath, context.id);
      for (const [name, path] of Object.entries(paths)) {
        process.stdout.write(`== ${name}: ${path} ==\n`);
        process.stdout.write(existsSync(path) ? readFileSync(path, "utf8") : "(no log)\n");
      }
      return 0;
    }
    throw new Error(`Unknown goal action "${action}".`);
  } finally {
    try {
      store.close();
    } catch {
      // Some actions close before starting a detached runtime.
    }
  }
}

function reconstructGoalWorktree(context: GoalContextRecord, checkout: string): void {
  if (context.worktreeDirty) {
    throw new Error("Cannot reconstruct a missing goal worktree whose checkpoint was dirty.");
  }
  if (!context.lastHead) {
    throw new Error("Cannot reconstruct a goal worktree without a durable HEAD checkpoint.");
  }
  const ref = git(checkout, ["rev-parse", context.branch]);
  if (ref !== context.lastHead) {
    throw new Error(
      `Goal branch ${context.branch} moved from checkpoint ${context.lastHead} to ${ref}; human reconciliation is required.`,
    );
  }
  mkdirSync(dirname(context.worktreePath), { recursive: true, mode: 0o700 });
  execFileSync("git", ["-C", checkout, "worktree", "prune"], { stdio: "pipe" });
  execFileSync(
    "git",
    ["-C", checkout, "worktree", "add", context.worktreePath, context.branch],
    { stdio: "pipe" },
  );
  if (git(context.worktreePath, ["rev-parse", "HEAD"]) !== context.lastHead) {
    throw new Error("Reconstructed goal worktree did not match its durable checkpoint.");
  }
}

async function runGoalGateway(
  positionals: string[],
  parsed: ParsedArguments,
  databasePath: string,
): Promise<number> {
  const contextId = requiredPositional(positionals, 0, "goal context ID");
  const gateway = new GoalGateway({
    databasePath,
    contextId,
    port: requiredIntegerOption(parsed, "port"),
    uploadDirectory: join(dirname(databasePath), "uploads", contextId),
  });
  await gateway.start();
  await Promise.race([gateway.fatal, new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  })]);
  await gateway.stop();
  return 0;
}

function checkpoint(worktree: string): {
  lastHead: string | null;
  worktreeDirty: boolean;
} {
  if (!existsSync(worktree)) {
    return { lastHead: null, worktreeDirty: true };
  }
  return {
    lastHead: git(worktree, ["rev-parse", "HEAD"]),
    worktreeDirty: git(worktree, ["status", "--porcelain"]).length > 0,
  };
}

function git(worktree: string, arguments_: string[]): string {
  return execFileSync("git", ["-C", worktree, ...arguments_], {
    encoding: "utf8",
  }).trim();
}

function runtimeSummary(context: {
  id: string;
  repository: string;
  issueNumber: number;
  state: string;
  threadId: string | null;
  contextUrl: string | null;
  generation: number;
}): Record<string, unknown> {
  return {
    goal: `${context.repository}#${context.issueNumber}`,
    contextId: context.id,
    state: context.state,
    threadId: context.threadId,
    contextUrl: context.contextUrl,
    generation: context.generation,
  };
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
  goal start OWNER/REPO#NUMBER [--worktree PATH] [--branch NAME]
    [--thread-id ID] [--app-port NUMBER] [--gateway-port NUMBER]
  goal stop|status|recover|open|logs|inspect OWNER/REPO#NUMBER
  goal status
  service install --owner LOGIN --project NUMBER [--checkout PATH]
  service start|stop|restart|status|logs|uninstall
  configure NAME ABSOLUTE_WORKTREE_PATH
  agents
  shared-server NAME --listen ws://127.0.0.1:PORT
  agent NAME [--remote ws://127.0.0.1:PORT]
  shared-deliver NAME --remote ws://127.0.0.1:PORT [--turn-timeout-ms NUMBER]
  deliver [runner options]
  turn-events MESSAGE_ID --reported-by NAME --attempt NUMBER --stream-id ID
    [--retry-after-ms NUMBER] [--history-incomplete] < codex-events.jsonl
  run --owner LOGIN --project NUMBER [--checkout PATH] [--once]
  run [--once] [--interval-ms NUMBER] [legacy runner options]

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
