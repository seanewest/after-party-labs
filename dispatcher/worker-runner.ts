import { existsSync } from "node:fs";
import { join } from "node:path";

import { formatHandoff } from "./handoff.ts";
import { DispatcherQueue, type QueueMessage } from "./queue.ts";
import type { AgentName } from "./registry.ts";
import { WorkerSessionStore } from "./session-store.ts";
import type { WorkerTerminal } from "./tmux-runner.ts";
import type { TurnOutcomeSource } from "./turn-outcome.ts";
import {
  FlockWorkerClientLock,
  type WorkerClientLock,
} from "./worker-lock.ts";

export interface DeliveryCoordinatorOptions {
  consumer?: string;
  leaseMs?: number;
  startupTimeoutMs?: number;
  receiptTimeoutMs?: number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  turnOutcomeSource?: TurnOutcomeSource;
  workerClientLock?: WorkerClientLock;
}

export interface DeliveryResult {
  outcome:
    | "empty"
    | "deferred"
    | "receipted"
    | "completed"
    | "retry_safe"
    | "failed";
  message: QueueMessage | null;
  error?: string;
}

export const ATTACHED_CLIENT_REASON =
  "The interactive Codex client is attached; automated delivery is waiting.";
export const AUTOMATED_TURN_REASON =
  "An automated structured Codex turn owns this worker session.";

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
  #turnOutcomeSource: TurnOutcomeSource | null;
  #workerClientLock: WorkerClientLock;

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
    this.#turnOutcomeSource = options.turnOutcomeSource ?? null;
    this.#workerClientLock =
      options.workerClientLock ?? new FlockWorkerClientLock(queue.databasePath);
    requirePositiveInteger(this.#leaseMs, "lease duration");
    requireNonNegativeInteger(this.#startupTimeoutMs, "startup timeout");
    requireNonNegativeInteger(this.#receiptTimeoutMs, "receipt timeout");
    requirePositiveInteger(this.#pollMs, "poll interval");
  }

  async syncAvailability(): Promise<void> {
    this.queue.requeueExpiredLeases();
    for (const worker of this.sessions.listWorkers()) {
      let current = this.queue.getWorker(worker.name);
      if (
        current.reason === AUTOMATED_TURN_REASON &&
        !this.#hasActiveStructuredTurn(worker.name)
      ) {
        const recovered = await this.#workerClientLock.tryAcquire(worker.name);
        if (recovered) {
          current = this.queue.setWorkerAvailability(worker.name, "idle");
          await recovered.release();
        }
      }
      if (
        !existsSync(worker.worktreePath) ||
        !existsSync(join(worker.worktreePath, ".git"))
      ) {
        this.queue.setWorkerAvailability(worker.name, "unavailable", {
          reason: `Configured worktree ${worker.worktreePath} is missing.`,
        });
      } else if (this.#turnOutcomeSource && this.terminal.hasSession(worker.name)) {
        if (this.terminal.hasAttachedClient(worker.name)) {
          if (current.availability !== "busy" || current.reason === ATTACHED_CLIENT_REASON) {
            this.queue.setWorkerAvailability(worker.name, "busy", {
              reason: ATTACHED_CLIENT_REASON,
            });
          }
        } else if (current.reason === ATTACHED_CLIENT_REASON) {
          this.queue.setWorkerAvailability(worker.name, "idle");
        }
      } else if (this.#turnOutcomeSource && current.reason === ATTACHED_CLIENT_REASON) {
        this.queue.setWorkerAvailability(worker.name, "idle");
      } else if (!this.#turnOutcomeSource && !this.terminal.hasSession(worker.name)) {
        this.queue.setWorkerAvailability(worker.name, "asleep");
      }
    }
  }

  #hasActiveStructuredTurn(name: AgentName): boolean {
    return (["leased", "delivering", "receipted", "acknowledged"] as const).some(
      (state) =>
        this.queue.listMessages({ state, recipient: name, limit: 1 }).length > 0,
    );
  }

  async deliverOnce(): Promise<DeliveryResult> {
    await this.syncAvailability();
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
      const prompt = formatHandoff(this.queue.inspect(message.id).message);
      if (this.#turnOutcomeSource) {
        const ownership = await this.#workerClientLock.tryAcquire(worker.name);
        if (!ownership) {
          return this.#defer(
            message,
            `Worker ${worker.name} already has an interactive or automated client.`,
          );
        }
        try {
          if (this.terminal.hasSession(worker.name)) {
            if (this.terminal.hasAttachedClient(worker.name)) {
              this.queue.setWorkerAvailability(worker.name, "busy", {
                reason: ATTACHED_CLIENT_REASON,
              });
              return this.#defer(
                message,
                `Worker ${worker.name} is attached for interactive use.`,
              );
            }
            this.queue.setWorkerAvailability(worker.name, "busy", {
              reason: AUTOMATED_TURN_REASON,
            });
            this.terminal.stop(worker.name);
          } else {
            this.queue.setWorkerAvailability(worker.name, "busy", {
              reason: AUTOMATED_TURN_REASON,
            });
          }

          this.queue.beginDelivery(message.id, this.#consumer);
          const outcome = await this.#withLeaseRenewal(
            message.id,
            this.#turnOutcomeSource.waitForOutcome(message, worker, prompt),
          );
          if (outcome.outcome === "completed") {
            return { outcome: "completed", message: outcome.message };
          }
          if (outcome.outcome === "retry_safe") {
            return { outcome: "retry_safe", message: outcome.result.message };
          }
          return { outcome: "failed", message: outcome.result.message };
        } finally {
          if (this.queue.getWorker(worker.name).reason === AUTOMATED_TURN_REASON) {
            this.queue.setWorkerAvailability(worker.name, "idle");
          }
          await ownership.release();
        }
      }

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
      this.terminal.inject(message.recipient, prompt);
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

  async #withLeaseRenewal<T>(messageId: string, operation: Promise<T>): Promise<T> {
    const interval = setInterval(() => {
      const current = this.queue.getMessage(messageId);
      if (
        current?.state === "delivering" &&
        current.leaseOwner === this.#consumer
      ) {
        this.queue.renewLease(messageId, this.#consumer, this.#leaseMs);
      }
    }, Math.max(25, Math.floor(this.#leaseMs / 3)));
    interval.unref();
    try {
      return await operation;
    } finally {
      clearInterval(interval);
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
    const current = this.queue.getMessage(message.id);
    if (current?.state === "completed") {
      return { outcome: "receipted", message: current };
    }
    if (current?.state === "receipted" || current?.state === "acknowledged") {
      const interruption = this.queue.reportTurnInterruption({
        messageId: message.id,
        reportedBy: message.recipient,
        reason,
        workStarted: null,
        retrySafe: false,
        dedupeKey: `runner-unclassified:${message.id}:${message.attemptCount}`,
        details: {
          source: "delivery_coordinator",
          attempt: message.attemptCount,
        },
      });
      return {
        outcome: "failed",
        message: interruption.message,
        error: reason,
      };
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
