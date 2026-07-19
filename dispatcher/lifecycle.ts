import { formatHandoff, parseHandoff } from "./handoff.ts";
import { DispatcherQueue, QueueError } from "./queue.ts";
import { WorkerSessionError, WorkerSessionStore } from "./session-store.ts";

export const LIFECYCLE_HOOK_REVISION = "1";

interface CommonHookInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
}

export interface SessionStartHookInput extends CommonHookInput {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact" | string;
}

export interface UserPromptSubmitHookInput extends CommonHookInput {
  hook_event_name: "UserPromptSubmit";
  turn_id: string;
  prompt: string;
}

export interface StopHookInput extends CommonHookInput {
  hook_event_name: "Stop";
  turn_id: string;
  stop_hook_active: boolean;
  last_assistant_message?: string | null;
}

export type LifecycleHookInput =
  | SessionStartHookInput
  | UserPromptSubmitHookInput
  | StopHookInput;

export type LifecycleHookOutput =
  | Record<string, never>
  | { decision: "block"; reason: string }
  | {
      hookSpecificOutput: {
        hookEventName: "SessionStart" | "UserPromptSubmit";
        additionalContext: string;
      };
    };

export class LifecycleHandler {
  private readonly queue: DispatcherQueue;
  private readonly sessions: WorkerSessionStore;
  private readonly now: () => number;

  constructor(
    queue: DispatcherQueue,
    sessions: WorkerSessionStore,
    now: () => number = Date.now,
  ) {
    this.queue = queue;
    this.sessions = sessions;
    this.now = now;
  }

  handle(input: LifecycleHookInput): LifecycleHookOutput {
    switch (input.hook_event_name) {
      case "SessionStart":
        return this.#sessionStart(input);
      case "UserPromptSubmit":
        return this.#userPromptSubmit(input);
      case "Stop":
        return this.#stop(input);
    }
  }

  #sessionStart(input: SessionStartHookInput): LifecycleHookOutput {
    const worker = this.sessions.getWorkerByCwd(input.cwd);
    if (!worker) {
      throw new WorkerSessionError(
        `No named worker is configured for hook cwd ${input.cwd}.`,
      );
    }
    const observedAt = this.now();
    this.sessions.registerSession({
      name: worker.name,
      cwd: input.cwd,
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
      hookRevision: LIFECYCLE_HOOK_REVISION,
      resetActiveTurn: input.source !== "compact",
      observedAt,
    });
    if (input.source !== "compact") {
      this.queue.setWorkerAvailability(worker.name, "idle", { observedAt });
    }
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          `You are the persistent named After Party worker ${worker.name.toUpperCase()}. ` +
          "Dispatcher handoffs arrive with a stable AFTER_PARTY_HANDOFF_V1 message ID.",
      },
    };
  }

  #userPromptSubmit(input: UserPromptSubmitHookInput): LifecycleHookOutput {
    const worker = this.#workerForSession(input.session_id, input.cwd);
    const parsed = parseHandoff(input.prompt);
    const observedAt = this.now();

    if (!parsed) {
      this.sessions.startTurn({
        name: worker.name,
        sessionId: input.session_id,
        turnId: input.turn_id,
        observedAt,
      });
      this.queue.setWorkerAvailability(worker.name, "busy", { observedAt });
      return {};
    }

    const { messageId } = parsed.envelope;
    const message = this.queue.getMessage(messageId);
    if (!message) {
      return { decision: "block", reason: `Unknown dispatcher message ${messageId}.` };
    }
    if (
      message.recipient !== worker.name ||
      parsed.envelope.recipient !== worker.name ||
      parsed.envelope.sender !== message.sender ||
      parsed.envelope.attempt !== message.attemptCount ||
      formatHandoff(message) !== input.prompt
    ) {
      return {
        decision: "block",
        reason: `Dispatcher message ${messageId} failed recipient or envelope validation.`,
      };
    }

    if (this.queue.inspect(messageId).receipt) {
      return {
        decision: "block",
        reason: `Dispatcher message ${messageId} was already receipted; duplicate processing is suppressed.`,
      };
    }

    this.sessions.startTurn({
      name: worker.name,
      sessionId: input.session_id,
      turnId: input.turn_id,
      messageId,
      observedAt,
    });
    this.queue.setWorkerAvailability(worker.name, "busy", { observedAt });
    this.queue.recordReceipt(messageId, worker.name, {
      sessionId: input.session_id,
      turnId: input.turn_id,
      hookRevision: LIFECYCLE_HOOK_REVISION,
    });

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          `Dispatcher message ${messageId} has a durable recipient receipt. ` +
          "The receipt confirms acceptance, not final completion.",
      },
    };
  }

  #stop(input: StopHookInput): LifecycleHookOutput {
    const worker = this.#workerForSession(input.session_id, input.cwd);
    const observedAt = this.now();
    const finished = this.sessions.finishTurn(
      worker.name,
      input.session_id,
      input.turn_id,
      observedAt,
    );
    if (finished.messageId) {
      const message = this.queue.getMessage(finished.messageId);
      if (message?.state === "receipted") {
        this.queue.acknowledge(finished.messageId);
      }
      const acknowledged = this.queue.getMessage(finished.messageId);
      if (acknowledged?.state === "acknowledged") {
        this.queue.complete(finished.messageId);
      }
    }
    if (finished.matched) {
      this.queue.setWorkerAvailability(worker.name, "idle", { observedAt });
    }
    return {};
  }

  #workerForSession(sessionId: string, cwd: string) {
    const worker = this.sessions.getWorkerBySession(sessionId);
    if (!worker) {
      throw new WorkerSessionError(`No named worker owns Codex session ${sessionId}.`);
    }
    const workerAtCwd = this.sessions.getWorkerByCwd(cwd);
    if (workerAtCwd?.name !== worker.name) {
      throw new WorkerSessionError(
        `Codex session ${sessionId} is not running in ${worker.worktreePath}.`,
      );
    }
    return worker;
  }
}

export function parseLifecycleInput(value: unknown): LifecycleHookInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QueueError("Lifecycle hook input must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const event = input.hook_event_name;
  requireString(input.session_id, "session_id");
  requireString(input.cwd, "cwd");
  if (event === "SessionStart") {
    requireString(input.source, "source");
  } else if (event === "UserPromptSubmit") {
    requireString(input.turn_id, "turn_id");
    requireString(input.prompt, "prompt", true);
  } else if (event === "Stop") {
    requireString(input.turn_id, "turn_id");
    if (typeof input.stop_hook_active !== "boolean") {
      throw new QueueError("Lifecycle hook field stop_hook_active must be a boolean.");
    }
  } else {
    throw new QueueError(`Unsupported lifecycle hook event ${String(event)}.`);
  }
  return input as unknown as LifecycleHookInput;
}

function requireString(
  value: unknown,
  field: string,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new QueueError(`Lifecycle hook field ${field} must be a string.`);
  }
}
