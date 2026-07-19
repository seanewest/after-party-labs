import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { parseAgentName, type AgentName } from "./registry.ts";

export interface WorkerClientLease {
  release(): Promise<void>;
}

export interface WorkerClientLock {
  tryAcquire(name: AgentName | string): Promise<WorkerClientLease | null>;
}

export interface FlockWorkerClientLockOptions {
  flockCommand?: string;
  holderCommand?: string;
  acquisitionTimeoutMs?: number;
}

export class WorkerClientLockError extends Error {}

export class FlockWorkerClientLock implements WorkerClientLock {
  #databasePath: string;
  #flockCommand: string;
  #holderCommand: string;
  #acquisitionTimeoutMs: number;

  constructor(databasePath: string, options: FlockWorkerClientLockOptions = {}) {
    this.#databasePath = databasePath;
    this.#flockCommand = options.flockCommand ?? "flock";
    this.#holderCommand = options.holderCommand ?? process.execPath;
    this.#acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? 2_000;
    if (
      !Number.isSafeInteger(this.#acquisitionTimeoutMs) ||
      this.#acquisitionTimeoutMs < 1
    ) {
      throw new WorkerClientLockError(
        "Worker lock acquisition timeout must be a positive integer.",
      );
    }
  }

  async tryAcquire(name: AgentName | string): Promise<WorkerClientLease | null> {
    const agent = parseAgentName(name);
    const child = spawn(
      this.#flockCommand,
      [
        "--nonblock",
        `${this.#databasePath}.worker-${agent}.lock`,
        this.#holderCommand,
        "-e",
        'process.stdout.write("LOCKED\\n"); process.stdin.resume();',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return waitForAcquisition(child, agent, this.#acquisitionTimeoutMs);
  }
}

async function waitForAcquisition(
  child: ChildProcessWithoutNullStreams,
  name: AgentName,
  timeoutMs: number,
): Promise<WorkerClientLease | null> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new WorkerClientLockError(`Timed out acquiring the ${name} worker lock.`));
    }, timeoutMs);
    timeout.unref();

    const finish = (result: WorkerClientLease | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("LOCKED\n")) {
        finish(new ChildWorkerClientLease(child));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const systemError = error as NodeJS.ErrnoException;
      reject(
        new WorkerClientLockError(
          systemError.code === "ENOENT"
            ? `${systemError.path ?? "flock"} is not installed.`
            : `Could not acquire the ${name} worker lock: ${error.message}`,
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (code === 1 && signal === null) {
        finish(null);
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const detail = errorOutput.trim() || (signal ? `signal ${signal}` : `exit ${code}`);
      reject(
        new WorkerClientLockError(
          `Could not acquire the ${name} worker lock: ${detail}`,
        ),
      );
    });
  });
}

class ChildWorkerClientLease implements WorkerClientLease {
  #child: ChildProcessWithoutNullStreams;
  #release: Promise<void> | null = null;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
  }

  release(): Promise<void> {
    this.#release ??= new Promise((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
        resolve();
        return;
      }
      this.#child.once("close", () => resolve());
      this.#child.stdin.end();
    });
    return this.#release;
  }
}
