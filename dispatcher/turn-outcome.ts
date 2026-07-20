import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  DispatcherQueue,
  QueueError,
  type QueueMessage,
  type TurnInterruptionResult,
} from "./queue.ts";
import { dispatcherDatabaseDirectory } from "./paths.ts";
import { parseAgentName, type AgentName } from "./registry.ts";
import type { WorkerSessionRecord } from "./session-store.ts";

export interface StructuredTurnContext {
  messageId: string;
  attemptNumber: number;
  reportedBy: AgentName | string;
  streamId: string;
  historyComplete?: boolean;
  retryAfterMs?: number;
}

export type StructuredTurnResult =
  | { outcome: "completed"; message: QueueMessage }
  | { outcome: "retry_safe" | "escalated"; result: TurnInterruptionResult };

export interface TurnOutcomeSource {
  waitForOutcome(
    message: QueueMessage,
    worker: WorkerSessionRecord,
    prompt: string,
  ): Promise<StructuredTurnResult>;
}

export interface CodexExecTurnOutcomeSourceOptions {
  codexCommand?: string;
  retryAfterMs?: number;
}

interface ParsedTerminalEvent {
  kind: "completed" | "failed";
  eventType: string;
  turnId: string | null;
  errorCode: string | null;
  fullItems: unknown[] | null;
}

const TRANSIENT_ERROR_CODES = new Set([
  "usageLimitExceeded",
  "sessionBudgetExceeded",
  "serverOverloaded",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "internalServerError",
]);

export class CodexExecTurnOutcomeSource implements TurnOutcomeSource {
  private readonly queue: DispatcherQueue;
  #codexCommand: string;
  #codexArgumentsPrefix: string[];
  #retryAfterMs: number | undefined;

  constructor(
    queue: DispatcherQueue,
    options: CodexExecTurnOutcomeSourceOptions = {},
  ) {
    this.queue = queue;
    this.#codexCommand = nonEmpty(options.codexCommand ?? "codex", "Codex command");
    const dispatcherDirectory = dispatcherDatabaseDirectory(queue.databasePath);
    this.#codexArgumentsPrefix = dispatcherDirectory
      ? ["--add-dir", dispatcherDirectory]
      : [];
    this.#retryAfterMs = options.retryAfterMs;
  }

  async waitForOutcome(
    message: QueueMessage,
    worker: WorkerSessionRecord,
    prompt: string,
  ): Promise<StructuredTurnResult> {
    const monitor = new StructuredTurnOutcomeMonitor(this.queue, {
      messageId: message.id,
      attemptNumber: message.attemptCount,
      reportedBy: message.recipient,
      streamId: `codex-exec:${message.id}:${message.attemptCount}`,
      retryAfterMs: this.#retryAfterMs,
    });
    const arguments_ = worker.sessionId
      ? [
          ...this.#codexArgumentsPrefix,
          "exec",
          "resume",
          "--json",
          worker.sessionId,
          "-",
        ]
      : [
          ...this.#codexArgumentsPrefix,
          "exec",
          "--json",
          "--color",
          "never",
          "-C",
          worker.worktreePath,
          "-",
        ];
    const child = spawn(this.#codexCommand, arguments_, {
      cwd: worker.worktreePath,
      env: {
        ...process.env,
        PARTY_DISPATCHER_DB: this.queue.databasePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let result: StructuredTurnResult | null = null;
    let streamError: Error | null = null;
    lines.on("line", (line) => {
      if (!line.trim() || streamError) {
        return;
      }
      try {
        const [event] = parseJsonLines(line);
        result = monitor.consume(event) ?? result;
      } catch (error) {
        streamError = error instanceof Error ? error : new Error(String(error));
        child.kill("SIGTERM");
      }
    });
    child.stderr.resume();
    child.stdin.end(prompt);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    if (streamError) {
      throw streamError;
    }
    if (result) {
      return result;
    }
    const exitLabel = exit.signal ? `signal ${exit.signal}` : `exit ${String(exit.code)}`;
    throw new QueueError(
      `Codex structured turn ended with ${exitLabel} and no terminal event.`,
    );
  }
}

export class StructuredTurnOutcomeMonitor {
  private readonly queue: DispatcherQueue;
  #messageId: string;
  #attemptNumber: number;
  #reportedBy: AgentName;
  #streamId: string;
  #historyComplete: boolean;
  #retryAfterMs: number;
  #workObserved = false;
  #finished: StructuredTurnResult | null = null;

  constructor(
    queue: DispatcherQueue,
    context: StructuredTurnContext,
  ) {
    this.queue = queue;
    this.#messageId = nonEmpty(context.messageId, "message ID");
    this.#attemptNumber = positiveInteger(context.attemptNumber, "attempt number");
    this.#reportedBy = parseAgentName(context.reportedBy);
    this.#streamId = nonEmpty(context.streamId, "stream ID");
    this.#historyComplete = context.historyComplete ?? true;
    this.#retryAfterMs = nonNegativeInteger(
      context.retryAfterMs ?? 5_000,
      "retry delay",
    );
    if (this.#retryAfterMs > 300_000) {
      throw new QueueError("Retry delay must not exceed 300000 milliseconds.");
    }
    const message = this.#message();
    if (message.recipient !== this.#reportedBy) {
      throw new QueueError(
        `Message ${message.id} is addressed to ${message.recipient}, not ${this.#reportedBy}.`,
      );
    }
    if (message.attemptCount !== this.#attemptNumber) {
      throw new QueueError(
        `Message ${message.id} is on attempt ${message.attemptCount}, not ${this.#attemptNumber}.`,
      );
    }
  }

  consume(value: unknown): StructuredTurnResult | null {
    if (this.#finished) {
      return this.#finished;
    }
    const event = requireObject(value, "Codex event");
    this.#observeWork(event);
    const terminal = parseTerminalEvent(event);
    if (!terminal) {
      return null;
    }

    if (terminal.fullItems) {
      this.#workObserved ||= terminal.fullItems.some(isWorkItem);
    } else if (terminal.eventType === "turn/completed") {
      this.#historyComplete = false;
    }

    if (terminal.kind === "completed") {
      let message = this.#message();
      if (message.state === "receipted") {
        message = this.queue.acknowledge(message.id);
      }
      if (message.state === "delivering") {
        throw new QueueError(
          `Worker ${message.recipient} completed message ${message.id} without a durable ` +
            "recipient receipt. Lifecycle hooks may be disabled, untrusted, changed, or unavailable.",
        );
      }
      if (message.state !== "acknowledged" && message.state !== "completed") {
        throw new QueueError(
          `Structured success cannot complete message ${message.id} from ${message.state}.`,
        );
      }
      this.#finished = {
        outcome: "completed",
        message: message.state === "completed" ? message : this.queue.complete(message.id),
      };
      return this.#finished;
    }

    const workStarted = this.#historyComplete ? this.#workObserved : null;
    const retrySafe =
      workStarted === false &&
      terminal.errorCode !== null &&
      TRANSIENT_ERROR_CODES.has(terminal.errorCode);
    const errorLabel = terminal.errorCode ?? "unclassified";
    const result = this.queue.reportTurnInterruption({
      messageId: this.#messageId,
      reportedBy: this.#reportedBy,
      reason: `Structured Codex ${terminal.eventType} (${errorLabel}).`,
      workStarted,
      retrySafe,
      dedupeKey:
        `${this.#streamId}:${terminal.turnId ?? "unknown-turn"}:` +
        `${terminal.eventType}:${this.#attemptNumber}`,
      retryAfterMs: retrySafe ? this.#retryAfterMs : undefined,
      details: {
        eventType: terminal.eventType,
        errorCode: terminal.errorCode,
        historyComplete: this.#historyComplete,
        workObserved: this.#workObserved,
      },
    });
    this.#finished = {
      outcome: result.interruption.disposition,
      result,
    };
    return this.#finished;
  }

  #message(): QueueMessage {
    const message = this.queue.getMessage(this.#messageId);
    if (!message) {
      throw new QueueError(`Message ${this.#messageId} does not exist.`);
    }
    return message;
  }

  #observeWork(event: Record<string, unknown>): void {
    const type = stringValue(event.type) ?? stringValue(event.method);
    if (type?.startsWith("item.") || type?.startsWith("item/")) {
      const params = objectValue(event.params);
      const item = event.item ?? params?.item;
      if (isWorkItem(item)) {
        this.#workObserved = true;
      }
    }
  }
}

export function parseJsonLines(value: string): unknown[] {
  return value
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        throw new QueueError(
          `Codex event line ${index + 1} is not valid JSON: ${String(error)}`,
        );
      }
    });
}

function parseTerminalEvent(event: Record<string, unknown>): ParsedTerminalEvent | null {
  const type = stringValue(event.type);
  if (type === "turn.completed") {
    return {
      kind: "completed",
      eventType: type,
      turnId: stringValue(event.turn_id),
      errorCode: null,
      fullItems: null,
    };
  }
  if (
    type === "error" &&
    (event.will_retry === true || event.willRetry === true)
  ) {
    return null;
  }
  if (type === "turn.failed" || type === "error") {
    return {
      kind: "failed",
      eventType: type,
      turnId: stringValue(event.turn_id),
      errorCode: errorCode(event.error ?? event),
      fullItems: null,
    };
  }

  const method = stringValue(event.method);
  const params = objectValue(event.params);
  if (method === "error") {
    if (params?.willRetry === true) {
      return null;
    }
    return {
      kind: "failed",
      eventType: method,
      turnId: stringValue(params?.turnId),
      errorCode: errorCode(params?.error),
      fullItems: null,
    };
  }
  if (method !== "turn/completed") {
    return null;
  }
  const turn = objectValue(params?.turn);
  const status = stringValue(turn?.status);
  const itemsView = stringValue(turn?.itemsView);
  const items = Array.isArray(turn?.items) && itemsView === "full" ? turn.items : null;
  if (status === "completed") {
    return {
      kind: "completed",
      eventType: method,
      turnId: stringValue(turn?.id),
      errorCode: null,
      fullItems: items,
    };
  }
  if (status === "failed" || status === "interrupted") {
    return {
      kind: "failed",
      eventType: method,
      turnId: stringValue(turn?.id),
      errorCode: errorCode(turn?.error),
      fullItems: items,
    };
  }
  return null;
}

function isWorkItem(value: unknown): boolean {
  const item = objectValue(value);
  const type = stringValue(item?.type);
  return Boolean(type && !["user_message", "userMessage", "hookPrompt"].includes(type));
}

function errorCode(value: unknown): string | null {
  const error = objectValue(value);
  const direct = stringValue(error?.code) ?? stringValue(error?.codex_error_info);
  if (direct) {
    return direct;
  }
  const info = error?.codexErrorInfo;
  if (typeof info === "string") {
    return info;
  }
  const objectInfo = objectValue(info);
  return objectInfo ? Object.keys(objectInfo)[0] ?? null : null;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  const object = objectValue(value);
  if (!object) {
    throw new QueueError(`${label} must be a JSON object.`);
  }
  return object;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new QueueError(`${label} must not be empty.`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new QueueError(`${label} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new QueueError(`${label} must be a non-negative integer.`);
  }
  return value;
}
