import { existsSync } from "node:fs";
import { join } from "node:path";

import { formatHandoff } from "./handoff.ts";
import { DispatcherQueue, type QueueMessage } from "./queue.ts";
import type { AgentName } from "./registry.ts";
import { WorkerSessionStore } from "./session-store.ts";
import type { WorkerTerminal } from "./tmux-runner.ts";

export interface DeliveryCoordinatorOptions {
  consumer?: string;
  leaseMs?: number;
  startupTimeoutMs?: number;
  receiptTimeoutMs?: number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface DeliveryResult {
  outcome: "empty" | "deferred" | "receipted" | "failed";
  message: QueueMessage | null;
  error?: string;
}

export class DeliveryCoordinator {
  private readonly queue: DispatcherQueue;
  private readonly sessions: WorkerSessionStore;
  private readonly terminal: WorkerTerminal;
  #consumer: string;
  #leaseMs: number;
  #startupTimeoutMs: number;
  #receiptTimeoutMs: number;
  #pollMs: number;
  #sleep: (milliseconds: number) => Promise<void>;

  constructor(
    queue: DispatcherQueue,
    sessions: WorkerSessionStore,
    terminal: WorkerTerminal,
    options: DeliveryCoordinatorOptions = {},
  ) {
    this.queue = queue;
    this.sessions = sessions;
    this.terminal = terminal;
    this.#consumer = options.consumer ?? `party-runner:${process.pid}`;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.#receiptTimeoutMs = options.receiptTimeoutMs ?? 15_000;
    this.#pollMs = options.pollMs ?? 100;
    this.#sleep = options.sleep ?? delay;
    requirePositiveInteger(this.#leaseMs, "lease duration");
    requireNonNegativeInteger(this.#startupTimeoutMs, "startup timeout");
    requireNonNegativeInteger(this.#receiptTimeoutMs, "receipt timeout");
    requirePositiveInteger(this.#pollMs, "poll interval");
  }

  syncAvailability(): void {
    for (const worker of this.sessions.listWorkers()) {
      if (
        !existsSync(worker.worktreePath) ||
        !existsSync(join(worker.worktreePath, ".git"))
      ) {
        this.queue.setWorkerAvailability(worker.name, "unavailable", {
          reason: `Configured worktree ${worker.worktreePath} is missing.`,
        });
      } else if (!this.terminal.hasSession(worker.name)) {
        this.queue.setWorkerAvailability(worker.name, "asleep");
      }
    }
  }

  async deliverOnce(): Promise<DeliveryResult> {
    this.syncAvailability();
    const message = this.queue.claimNext({
      consumer: this.#consumer,
      leaseMs: this.#leaseMs,
      workerAvailabilities: ["idle", "asleep"],
    });
    if (!message) {
      return { outcome: "empty", message: null };
    }

    try {
      const worker = this.sessions.requireWorker(message.recipient);
      this.terminal.start(worker);
      const ready = await this.#waitForIdle(
        message.recipient,
        message.id,
        this.#startupTimeoutMs,
      );
      if (!ready) {
        return this.#defer(message, `Worker ${message.recipient} remained busy or did not start.`);
      }

      this.queue.beginDelivery(message.id, this.#consumer);
      this.terminal.inject(message.recipient, formatHandoff(this.queue.inspect(message.id).message));
      const receipted = await this.#waitForReceipt(message.id);
      if (!receipted) {
        return this.#fail(
          message,
          `Worker ${message.recipient} did not record a recipient receipt before timeout.`,
        );
      }
      const current = this.queue.getMessage(message.id);
      if (current?.state === "receipted") {
        this.queue.acknowledge(message.id);
      }
      return { outcome: "receipted", message: this.queue.getMessage(message.id) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.#fail(message, reason);
    }
  }

  async #waitForIdle(
    name: AgentName,
    messageId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (this.queue.getWorker(name).availability === "idle") {
        return true;
      }
      const message = this.queue.getMessage(messageId);
      if (message?.state !== "leased") {
        return false;
      }
      this.queue.renewLease(messageId, this.#consumer, this.#leaseMs);
      await this.#sleep(this.#pollMs);
    }
    return false;
  }

  async #waitForReceipt(messageId: string): Promise<boolean> {
    const deadline = Date.now() + this.#receiptTimeoutMs;
    while (Date.now() <= deadline) {
      if (this.queue.inspect(messageId).receipt) {
        return true;
      }
      const current = this.queue.getMessage(messageId);
      if (current?.state !== "leased" && current?.state !== "delivering") {
        return Boolean(this.queue.inspect(messageId).receipt);
      }
      this.queue.renewLease(messageId, this.#consumer, this.#leaseMs);
      await this.#sleep(this.#pollMs);
    }
    return false;
  }

  #defer(message: QueueMessage, reason: string): DeliveryResult {
    const current = this.queue.getMessage(message.id);
    if (current?.state === "leased" || current?.state === "delivering") {
      this.queue.fail(message.id, this.#consumer, reason);
      this.queue.retry(message.id, Date.now() + this.#pollMs);
    }
    return { outcome: "deferred", message: this.queue.getMessage(message.id), error: reason };
  }

  #fail(message: QueueMessage, reason: string): DeliveryResult {
    let current = this.queue.getMessage(message.id);
    if (current && ["receipted", "acknowledged", "completed"].includes(current.state)) {
      if (current.state === "receipted") {
        current = this.queue.acknowledge(message.id);
      }
      return { outcome: "receipted", message: current };
    }
    if (
      current &&
      (current.state === "leased" || current.state === "delivering") &&
      current.leaseOwner === this.#consumer
    ) {
      this.queue.fail(message.id, this.#consumer, reason);
    }
    this.queue.createEscalation({
      kind: "delivery_failure",
      requestedBy: "morpheus",
      subjectAgent: message.recipient,
      messageId: message.id,
      summary: reason,
      details: { attempt: message.attemptCount },
      dedupeKey: `delivery-failure:${message.id}:${message.attemptCount}`,
    });
    return { outcome: "failed", message: this.queue.getMessage(message.id), error: reason };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}
