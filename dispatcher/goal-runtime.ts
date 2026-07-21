import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "./app-server-client.ts";
import { GoalContextStore, type GoalContextRecord } from "./goal-context.ts";

export interface GoalRuntimeStartOptions {
  databasePath: string;
  appPort?: number;
  gatewayPort?: number;
  codexCommand?: string;
  nodeCommand?: string;
  partyPath?: string;
  startupTimeoutMs?: number;
}

const DEFAULT_GATEWAY_PORT = 43_134;

export async function startGoalRuntime(
  contextId: string,
  options: GoalRuntimeStartOptions,
): Promise<GoalContextRecord> {
  const store = new GoalContextStore(options.databasePath);
  try {
    const context = store.require(contextId);
    const existingHealth = await functionalHealth(context);
    if (existingHealth.gatewayAlive && existingHealth.appServerAlive) {
      return context;
    }
    if (!store.tryBeginRuntimeStart(context.id, context.generation)) {
      throw new Error(
        `Goal ${context.repository}#${context.issueNumber} runtime start is already owned.`,
      );
    }
    safeKill(context.gatewayPid, ["goal-gateway", context.id]);
    safeKill(context.appServerPid, ["codex", "app-server", context.appEndpoint ?? ""]);
    await waitForExit([context.gatewayPid, context.appServerPid], 5_000);
    const appPort = options.appPort ?? (await availablePort());
    const gatewayPort =
      options.gatewayPort ?? contextUrlPort(context.contextUrl) ?? (await availablePortFrom(DEFAULT_GATEWAY_PORT));
    const endpoint = `ws://127.0.0.1:${appPort}`;
    const contextUrl = `http://127.0.0.1:${gatewayPort}/contexts/${context.id}`;
    const logs = runtimeLogs(options.databasePath, context.id);
    mkdirSync(dirname(logs.appServer), { recursive: true, mode: 0o700 });
    const appFd = openSync(logs.appServer, "a", 0o600);
    let gateway: ChildProcess | null = null;
    const app = spawn(
      options.codexCommand ?? "codex",
      [
        "-c", 'model="gpt-5.6-sol"',
        "-c", 'model_reasoning_effort="medium"',
        "app-server", "--listen", endpoint,
      ],
      {
        cwd: context.worktreePath,
        detached: true,
        stdio: ["ignore", appFd, appFd],
      },
    );
    closeSync(appFd);
    await waitForSpawn(app, "Codex app-server");
    app.unref();
    store.updateRuntime(context.id, {
      appEndpoint: endpoint,
      contextUrl,
      appServerPid: app.pid ?? null,
      gatewayPid: null,
      lastError: null,
    });

    try {
      await waitForPort(appPort, options.startupTimeoutMs ?? 15_000);
      const gatewayFd = openSync(logs.gateway, "a", 0o600);
      const partyPath =
        options.partyPath ?? fileURLToPath(new URL("./party.ts", import.meta.url));
      gateway = spawn(
        options.nodeCommand ?? process.execPath,
        [
          partyPath,
          "--database",
          options.databasePath,
          "goal-gateway",
          context.id,
          "--port",
          String(gatewayPort),
        ],
        {
          cwd: context.worktreePath,
          detached: true,
          stdio: ["ignore", gatewayFd, gatewayFd],
        },
      );
      closeSync(gatewayFd);
      await waitForSpawn(gateway, "goal gateway");
      gateway.unref();
      store.updateRuntime(context.id, { gatewayPid: gateway.pid ?? null });
      await waitForHttp(`${contextUrl}/status`, options.startupTimeoutMs ?? 15_000);
      return store.require(context.id);
    } catch (error) {
      safeKill(gateway?.pid ?? null, ["goal-gateway", context.id]);
      safeKill(app.pid ?? null, ["codex", "app-server", endpoint]);
      await waitForExit([gateway?.pid ?? null, app.pid ?? null], 5_000).catch(() => {});
      store.updateRuntime(context.id, {
        state: "error",
        appServerPid: null,
        gatewayPid: null,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } finally {
    store.close();
  }
}

export async function stopGoalRuntime(
  contextId: string,
  databasePath: string,
): Promise<GoalContextRecord> {
  const store = new GoalContextStore(databasePath);
  try {
    const context = store.require(contextId);
    safeKill(context.gatewayPid, ["goal-gateway", context.id]);
    safeKill(context.appServerPid, ["codex", "app-server", context.appEndpoint ?? ""]);
    await waitForExit([context.gatewayPid, context.appServerPid], 5_000);
    return store.updateRuntime(context.id, {
      appServerPid: null,
      gatewayPid: null,
      state: "stopped",
      pendingOperation: null,
      lastError: null,
    });
  } finally {
    store.close();
  }
}

export async function inspectGoalRuntime(
  contextId: string,
  databasePath: string,
): Promise<{ context: GoalContextRecord; appServerAlive: boolean; gatewayAlive: boolean }> {
  const store = new GoalContextStore(databasePath);
  try {
    const context = store.require(contextId);
    return { context, ...await functionalHealth(context) };
  } finally {
    store.close();
  }
}

async function functionalHealth(context: GoalContextRecord): Promise<{
  appServerAlive: boolean;
  gatewayAlive: boolean;
}> {
  let appServerAlive = isExpectedProcess(
    context.appServerPid,
    ["codex", "app-server", context.appEndpoint ?? ""],
  );
  let gatewayAlive = isExpectedProcess(context.gatewayPid, ["goal-gateway", context.id]);
  if (appServerAlive && context.appEndpoint) {
    try {
      const probe = await CodexAppServerClient.connect(context.appEndpoint, {
        connectTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        clientName: "after-party-health-probe",
      });
      probe.close();
    } catch {
      appServerAlive = false;
    }
  }
  if (gatewayAlive && context.contextUrl) {
    try {
      const response = await fetch(`${context.contextUrl}/status`, {
        signal: AbortSignal.timeout(1_000),
      });
      const status = await response.json() as Record<string, unknown>;
      gatewayAlive = response.ok && status.contextId === context.id && status.connected === true;
    } catch {
      gatewayAlive = false;
    }
  }
  return { appServerAlive, gatewayAlive };
}

export function runtimeLogs(
  databasePath: string,
  contextId: string,
): { appServer: string; gateway: string } {
  const directory = join(dirname(databasePath), "logs", contextId);
  return {
    appServer: join(directory, "app-server.log"),
    gateway: join(directory, "gateway.log"),
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function availablePortFrom(start: number): Promise<number> {
  for (let port = start; port < start + 1_000; port += 1) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    } catch {
      server.close();
    }
  }
  throw new Error("No loopback gateway port is available.");
}

function contextUrlPort(value: string | null): number | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return Number.isSafeInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not listening";
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(100);
    }
  }
  throw new Error(`Codex app-server did not listen on port ${port}: ${lastError}`);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not responding";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Goal gateway did not become ready: ${lastError}`);
}

function isAlive(pid: number | null): boolean {
  if (!pid || pid < 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isExpectedProcess(pid: number | null, expected: string[]): boolean {
  return isAlive(pid) && expected.filter(Boolean).every((part) => readCommand(pid!).includes(part));
}

async function waitForSpawn(child: ChildProcess, label: string): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new Error(`${label} failed to spawn: ${error.message}`)));
  });
}

async function waitForExit(pids: Array<number | null>, timeoutMs: number): Promise<void> {
  const live = pids.filter((pid): pid is number => Boolean(pid));
  const deadline = Date.now() + timeoutMs;
  while (live.some(isAlive) && Date.now() < deadline) {
    await delay(50);
  }
  if (live.some(isAlive)) {
    throw new Error(`Timed out waiting for prior goal runtime PIDs ${live.join(", ")} to stop.`);
  }
}

function safeKill(pid: number | null, expected: string[]): void {
  if (!isAlive(pid)) {
    return;
  }
  const command = readCommand(pid!);
  if (!expected.filter(Boolean).every((part) => command.includes(part))) {
    throw new Error(
      `Refusing to stop PID ${pid}; its command does not match this goal runtime.`,
    );
  }
  try {
    process.kill(pid!, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function readCommand(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
