import {
  CodexAppServerClient,
  validateLocalAppServerEndpoint,
  type CodexAppServerNotification,
} from "./app-server-client.ts";
import { formatHandoff } from "./handoff.ts";
import {
  DispatcherQueue,
  type QueueMessage,
  type TurnInterruptionResult,
} from "./queue.ts";
import type { AgentName } from "./registry.ts";
import { WorkerSessionStore } from "./session-store.ts";
import {
  StructuredTurnOutcomeMonitor,
  type StructuredTurnResult,
} from "./turn-outcome.ts";

interface SharedWorkerClient {
  onNotification(
    listener: (notification: CodexAppServerNotification) => void,
  ): () => void;
  resumeThread(threadId: string, cwd?: string): Promise<{ id: string }>;
  startTurn(
    threadId: string,
    input: Array<{ type: "text"; text: string }>,
  ): Promise<{ id: string }>;
  waitForTurnCompletion(
    turnId: string,
    timeoutMs?: number,
  ): Promise<CodexAppServerNotification>;
  close(): void;
}

export interface SharedWorkerPrototypeOptions {
  endpoint: string;
  recipient: AgentName;
  consumer?: string;
  leaseMs?: number;
  turnTimeoutMs?: number;
  connect?: (endpoint: string) => Promise<SharedWorkerClient>;
}

export type SharedWorkerPrototypeResult =
  | { outcome: "idle" }
  | { outcome: "completed"; message: QueueMessage; turnId: string }
  | {
      outcome: "retry_safe" | "escalated";
      result: TurnInterruptionResult;
      turnId: string;
    }
  | { outcome: "failed"; message: QueueMessage; error: string };

/**
 * Bounded Task #63 delivery proof. It is intentionally not wired into normal
 * `party deliver`: Task #64 must own app-server supervision and migration.
 */
export class SharedWorkerDeliveryPrototype {
  #queue: DispatcherQueue;
  #sessions: WorkerSessionStore;
  #endpoint: string;
  #recipient: AgentName;
  #consumer: string;
  #leaseMs: number;
  #turnTimeoutMs: number;
  #connect: (endpoint: string) => Promise<SharedWorkerClient>;

  constructor(
    queue: DispatcherQueue,
    sessions: WorkerSessionStore,
    options: SharedWorkerPrototypeOptions,
  ) {
    this.#queue = queue;
    this.#sessions = sessions;
    this.#endpoint = validateLocalAppServerEndpoint(options.endpoint);
    this.#recipient = options.recipient;
    this.#consumer = options.consumer?.trim() || "shared-worker-prototype";
    this.#leaseMs = positiveInteger(options.leaseMs ?? 30_000, "lease duration");
    this.#turnTimeoutMs = positiveInteger(
      options.turnTimeoutMs ?? 300_000,
      "turn timeout",
    );
    this.#connect =
      options.connect ?? ((endpoint) => CodexAppServerClient.connect(endpoint));
  }

  async deliverOnce(): Promise<SharedWorkerPrototypeResult> {
    const message = this.#queue.claimNext({
      consumer: this.#consumer,
      leaseMs: this.#leaseMs,
      recipient: this.#recipient,
      workerAvailabilities: ["idle", "asleep"],
    });
    if (!message) {
      return { outcome: "idle" };
    }

    let client: SharedWorkerClient | null = null;
    let turnId: string | null = null;
    try {
      const worker = this.#sessions.requireWorker(message.recipient);
      if (!worker.sessionId) {
        throw new Error(
          `Worker ${worker.name} has no saved Codex thread for the shared app-server.`,
        );
      }
      this.#queue.beginDelivery(message.id, this.#consumer);
      client = await this.#connect(this.#endpoint);
      await client.resumeThread(worker.sessionId, worker.worktreePath);

      const buffered: CodexAppServerNotification[] = [];
      let monitor: StructuredTurnOutcomeMonitor | null = null;
      let result: StructuredTurnResult | null = null;
      let streamError: Error | null = null;
      const unsubscribe = client.onNotification((notification) => {
        if (!isOutcomeNotification(notification)) {
          return;
        }
        if (!monitor) {
          buffered.push(notification);
          return;
        }
        if (!turnId || !belongsToTurn(notification, worker.sessionId!, turnId)) {
          return;
        }
        try {
          result = monitor.consume(notification) ?? result;
        } catch (error) {
          streamError = error instanceof Error ? error : new Error(String(error));
        }
      });
      try {
        const turn = await client.startTurn(worker.sessionId, [
          { type: "text", text: formatHandoff(message) },
        ]);
        turnId = turn.id;

        // The successful turn/start response is the app-server's structured
        // acceptance boundary. Persist it before waiting for model work.
        this.#queue.recordReceipt(message.id, message.recipient, {
          source: "codex-app-server",
          endpoint: this.#endpoint,
          threadId: worker.sessionId,
          turnId,
        });
        this.#queue.acknowledge(message.id);
        monitor = new StructuredTurnOutcomeMonitor(this.#queue, {
          messageId: message.id,
          attemptNumber: message.attemptCount,
          reportedBy: message.recipient,
          streamId: `codex-app-server:${worker.sessionId}:${turnId}`,
        });
        for (const notification of buffered) {
          if (belongsToTurn(notification, worker.sessionId, turnId)) {
            result = monitor.consume(notification) ?? result;
          }
        }

        const terminal = await client.waitForTurnCompletion(
          turnId,
          this.#turnTimeoutMs,
        );
        if (streamError) {
          throw streamError;
        }
        result = monitor.consume(terminal) ?? result;
        if (!result) {
          throw new Error(
            `Codex app-server ended turn ${turnId} without a classifiable outcome.`,
          );
        }
        return prototypeResult(result, turnId);
      } finally {
        unsubscribe();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = this.#queue.getMessage(message.id);
      if (current && ["leased", "delivering"].includes(current.state)) {
        return {
          outcome: "failed",
          message: this.#queue.fail(message.id, this.#consumer, reason),
          error: reason,
        };
      }
      if (
        current &&
        ["receipted", "acknowledged"].includes(current.state)
      ) {
        const interruption = this.#queue.reportTurnInterruption({
          messageId: message.id,
          reportedBy: message.recipient,
          reason: `Shared Codex app-server stream was lost: ${reason}`,
          workStarted: null,
          retrySafe: false,
          dedupeKey:
            `codex-app-server:${workerKey(message)}:${turnId ?? "unknown-turn"}:` +
            `stream-lost:${message.attemptCount}`,
          details: {
            endpoint: this.#endpoint,
            turnId,
            error: reason,
          },
        });
        return {
          outcome: interruption.interruption.disposition,
          result: interruption,
          turnId: turnId ?? "unknown-turn",
        };
      }
      return {
        outcome: "failed",
        message: current ?? message,
        error: reason,
      };
    } finally {
      client?.close();
    }
  }
}

function prototypeResult(
  result: StructuredTurnResult,
  turnId: string,
): SharedWorkerPrototypeResult {
  if (result.outcome === "completed") {
    return { outcome: "completed", message: result.message, turnId };
  }
  return { outcome: result.outcome, result: result.result, turnId };
}

function workerKey(message: QueueMessage): string {
  return `${message.recipient}:${message.id}`;
}

function isOutcomeNotification(notification: CodexAppServerNotification): boolean {
  return (
    notification.method === "error" ||
    notification.method === "turn/completed" ||
    notification.method.startsWith("item/")
  );
}

function belongsToTurn(
  notification: CodexAppServerNotification,
  threadId: string,
  turnId: string,
): boolean {
  const params = notification.params;
  if (typeof params?.threadId === "string" && params.threadId !== threadId) {
    return false;
  }
  const turn =
    params?.turn !== null &&
    typeof params?.turn === "object" &&
    !Array.isArray(params.turn)
      ? (params.turn as Record<string, unknown>)
      : null;
  const observedTurnId =
    typeof params?.turnId === "string"
      ? params.turnId
      : typeof turn?.id === "string"
        ? turn.id
        : null;
  return observedTurnId === turnId;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}
