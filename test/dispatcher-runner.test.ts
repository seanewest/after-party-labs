import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { formatHandoff, parseHandoff } from "../dispatcher/handoff.ts";
import { LifecycleHandler } from "../dispatcher/lifecycle.ts";
import { DispatcherQueue } from "../dispatcher/queue.ts";
import { WorkerSessionStore, type WorkerSessionRecord } from "../dispatcher/session-store.ts";
import {
  TmuxWorkerTerminal,
  type CommandExecutor,
  type WorkerTerminal,
} from "../dispatcher/tmux-runner.ts";
import { StructuredTurnOutcomeMonitor } from "../dispatcher/turn-outcome.ts";
import { DeliveryCoordinator } from "../dispatcher/worker-runner.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "after-party-runner-"));
  const worktree = join(directory, "worktree");
  mkdirSync(join(worktree, ".git"), { recursive: true });
  const databasePath = join(directory, "dispatcher.sqlite");
  let currentTime = 1_000;
  const queue = new DispatcherQueue(databasePath, { now: () => currentTime });
  const sessions = new WorkerSessionStore(databasePath, { now: () => currentTime });
  return {
    directory,
    worktree,
    queue,
    sessions,
    now: () => currentTime,
    tick() {
      currentTime += 1;
      return currentTime;
    },
    cleanup() {
      sessions.close();
      queue.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

class FakeTerminal implements WorkerTerminal {
  readonly running = new Set<string>();
  readonly starts: WorkerSessionRecord[] = [];
  readonly injections: Array<{ name: string; prompt: string }> = [];
  readonly attachments: string[] = [];
  onStart?: (worker: WorkerSessionRecord) => void;
  onInject?: (name: string, prompt: string) => void;

  hasSession(name: string): boolean {
    return this.running.has(name);
  }

  start(worker: WorkerSessionRecord): void {
    if (!this.running.has(worker.name)) {
      this.running.add(worker.name);
      this.starts.push(worker);
      this.onStart?.(worker);
    }
  }

  attach(name: string): void {
    this.attachments.push(name);
  }

  inject(name: string, prompt: string): void {
    this.injections.push({ name, prompt });
    this.onInject?.(name, prompt);
  }
}

test("handoff envelopes carry one stable, machine-readable message ID", () => {
  const state = fixture();
  try {
    const message = state.queue.enqueue({
      id: "stable-message-id",
      sender: "morpheus",
      recipient: "beavis",
      payload: { kind: "agent_message", text: "Review the proposed Story." },
    });
    state.queue.setWorkerAvailability("beavis", "idle");
    const claimed = state.queue.claimNext({ consumer: "runner", leaseMs: 100 });
    assert.ok(claimed);
    const prompt = formatHandoff(claimed);
    const parsed = parseHandoff(prompt);
    assert.equal(parsed?.envelope.messageId, message.id);
    assert.equal(parsed?.envelope.attempt, 1);
    assert.equal(parsed?.body, "Review the proposed Story.");
    assert.equal(parseHandoff("ordinary human prompt"), null);
  } finally {
    state.cleanup();
  }
});

test("lifecycle hooks permit only a structured retry and leave completion to turn events", () => {
  const state = fixture();
  try {
    state.sessions.configureWorker("beavis", state.worktree);
    const lifecycle = new LifecycleHandler(state.queue, state.sessions, state.now);
    const startOutput = lifecycle.handle({
      hook_event_name: "SessionStart",
      session_id: SESSION_A,
      transcript_path: join(state.directory, "transcript.jsonl"),
      cwd: state.worktree,
      source: "startup",
    });
    assert.match(JSON.stringify(startOutput), /BEAVIS/);
    assert.equal(state.queue.getWorker("beavis").availability, "idle");
    assert.equal(state.sessions.getWorker("beavis")?.sessionId, SESSION_A);

    const enqueued = state.queue.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "Process this handoff." },
    });
    const claimed = state.queue.claimNext({
      consumer: "runner",
      leaseMs: 500,
      workerAvailabilities: ["idle"],
    });
    assert.equal(claimed?.id, enqueued.id);
    state.queue.beginDelivery(enqueued.id, "runner");
    const prompt = formatHandoff(state.queue.inspect(enqueued.id).message);

    state.tick();
    lifecycle.handle({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION_A,
      cwd: state.worktree,
      turn_id: "turn-1",
      prompt,
    });
    assert.equal(state.queue.getMessage(enqueued.id)?.state, "receipted");
    assert.equal(state.queue.getWorker("beavis").availability, "busy");
    assert.equal(state.sessions.getWorker("beavis")?.activeMessageId, enqueued.id);

    const duplicate = lifecycle.handle({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION_A,
      cwd: state.worktree,
      turn_id: "turn-duplicate",
      prompt,
    });
    assert.deepEqual(duplicate, {
      decision: "block",
      reason:
        `Dispatcher message ${enqueued.id} already has a receipt and no structured ` +
        "retry-safe interruption authorizes this attempt.",
    });

    state.tick();
    lifecycle.handle({
      hook_event_name: "Stop",
      session_id: SESSION_A,
      cwd: state.worktree,
      turn_id: "turn-1",
      stop_hook_active: false,
      last_assistant_message: "Done",
    });
    assert.equal(state.queue.getMessage(enqueued.id)?.state, "receipted");
    assert.equal(state.queue.getWorker("beavis").availability, "idle");

    const interrupted = new StructuredTurnOutcomeMonitor(state.queue, {
      messageId: enqueued.id,
      attemptNumber: 1,
      reportedBy: "beavis",
      streamId: "stream-turn-1",
      retryAfterMs: 0,
    }).consume({
      type: "turn.failed",
      turn_id: "turn-1",
      error: { code: "usageLimitExceeded" },
    });
    assert.equal(interrupted?.outcome, "retry_safe");
    assert.equal(state.queue.getMessage(enqueued.id)?.state, "queued");
    assert.ok(state.queue.inspect(enqueued.id).receipt);

    const retry = state.queue.claimNext({
      consumer: "runner-retry",
      leaseMs: 500,
      workerAvailabilities: ["idle"],
    });
    assert.equal(retry?.attemptCount, 2);
    state.queue.beginDelivery(enqueued.id, "runner-retry");
    const retryPrompt = formatHandoff(state.queue.inspect(enqueued.id).message);
    state.tick();
    const acceptedRetry = lifecycle.handle({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION_A,
      cwd: state.worktree,
      turn_id: "turn-2",
      prompt: retryPrompt,
    });
    assert.match(JSON.stringify(acceptedRetry), /attempt 2/);
    assert.equal(state.queue.getMessage(enqueued.id)?.state, "receipted");

    const completed = new StructuredTurnOutcomeMonitor(state.queue, {
      messageId: enqueued.id,
      attemptNumber: 2,
      reportedBy: "beavis",
      streamId: "stream-turn-2",
    }).consume({ type: "turn.completed", turn_id: "turn-2" });
    assert.equal(completed?.outcome, "completed");
    assert.equal(state.queue.getMessage(enqueued.id)?.state, "completed");
  } finally {
    state.cleanup();
  }
});

test("human turns mark a worker busy, compact preserves the active turn, and Stop clears it", () => {
  const state = fixture();
  try {
    state.sessions.configureWorker("daria", state.worktree);
    const lifecycle = new LifecycleHandler(state.queue, state.sessions, state.now);
    lifecycle.handle({
      hook_event_name: "SessionStart",
      session_id: SESSION_A,
      cwd: state.worktree,
      source: "startup",
    });
    state.tick();
    lifecycle.handle({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION_A,
      cwd: state.worktree,
      turn_id: "human-turn",
      prompt: "Check the board",
    });
    assert.equal(state.queue.getWorker("daria").availability, "busy");

    state.tick();
    lifecycle.handle({
      hook_event_name: "SessionStart",
      session_id: SESSION_A,
      cwd: state.worktree,
      source: "compact",
    });
    assert.equal(state.sessions.getWorker("daria")?.activeTurnId, "human-turn");
    assert.equal(state.queue.getWorker("daria").availability, "busy");

    state.tick();
    lifecycle.handle({
      hook_event_name: "Stop",
      session_id: SESSION_A,
      cwd: state.worktree,
      turn_id: "human-turn",
      stop_hook_active: false,
    });
    assert.equal(state.sessions.getWorker("daria")?.activeTurnId, null);
    assert.equal(state.queue.getWorker("daria").availability, "idle");
  } finally {
    state.cleanup();
  }
});

test("structured delivery resumes a sleeping worker and completes from its event stream", async () => {
  const state = fixture();
  try {
    state.sessions.configureWorker("cornholio", state.worktree);
    const lifecycle = new LifecycleHandler(state.queue, state.sessions, state.now);
    lifecycle.handle({
      hook_event_name: "SessionStart",
      session_id: SESSION_B,
      cwd: state.worktree,
      source: "startup",
    });
    state.queue.setWorkerAvailability("cornholio", "asleep");
    const message = state.queue.enqueue({
      sender: "morpheus",
      recipient: "cornholio",
      payload: { text: "Wake and review." },
    });

    const terminal = new FakeTerminal();
    const coordinator = new DeliveryCoordinator(
      state.queue,
      state.sessions,
      terminal,
      {
        consumer: "runner",
        leaseMs: 500,
        pollMs: 1,
        turnOutcomeSource: {
          async waitForOutcome(accepted, worker, prompt) {
            assert.equal(worker.sessionId, SESSION_B);
            state.tick();
            lifecycle.handle({
              hook_event_name: "UserPromptSubmit",
              session_id: SESSION_B,
              cwd: state.worktree,
              turn_id: "delivery-turn",
              prompt,
            });
            const outcome = new StructuredTurnOutcomeMonitor(state.queue, {
              messageId: accepted.id,
              attemptNumber: accepted.attemptCount,
              reportedBy: accepted.recipient,
              streamId: "delivery-stream",
            }).consume({ type: "turn.completed", turn_id: "delivery-turn" });
            if (!outcome) {
              throw new Error("Expected a terminal structured outcome.");
            }
            return outcome;
          },
        },
      },
    );
    const result = await coordinator.deliverOnce();
    assert.equal(result.outcome, "completed");
    assert.equal(terminal.starts.length, 0);
    assert.equal(terminal.injections.length, 0);
    assert.equal(state.queue.getMessage(message.id)?.state, "completed");

    state.tick();
    lifecycle.handle({
      hook_event_name: "Stop",
      session_id: SESSION_B,
      cwd: state.worktree,
      turn_id: "delivery-turn",
      stop_hook_active: false,
    });
    assert.equal(state.queue.getMessage(message.id)?.state, "completed");
  } finally {
    state.cleanup();
  }
});

test("structured outcomes retry only pre-work transient failures and escalate after work", () => {
  const state = fixture();
  try {
    state.queue.setWorkerAvailability("daria", "idle");
    const ambiguous = state.queue.enqueue({
      sender: "morpheus",
      recipient: "daria",
      payload: { text: "Do not replay completed work." },
    });
    state.queue.claimNext({ consumer: "runner", leaseMs: 500 });
    state.queue.beginDelivery(ambiguous.id, "runner");
    state.queue.recordReceipt(ambiguous.id, "daria", { turnId: "turn-work" });
    state.queue.acknowledge(ambiguous.id);

    const worked = new StructuredTurnOutcomeMonitor(state.queue, {
      messageId: ambiguous.id,
      attemptNumber: 1,
      reportedBy: "daria",
      streamId: "stream-with-work",
    });
    assert.equal(
      worked.consume({
        type: "item.started",
        item: { id: "reasoning-1", type: "reasoning" },
      }),
      null,
    );
    const escalated = worked.consume({
      type: "error",
      turn_id: "turn-work",
      error: { code: "serverOverloaded" },
    });
    assert.equal(escalated?.outcome, "escalated");
    assert.equal(state.queue.getMessage(ambiguous.id)?.state, "failed");
    assert.equal(state.queue.inspect(ambiguous.id).interruptions[0]?.workStarted, true);
    assert.equal(state.queue.listEscalations({ kind: "delivery_failure" }).length, 1);

    const retryable = state.queue.enqueue({
      sender: "morpheus",
      recipient: "daria",
      payload: { text: "Retry only if the full turn proves no work began." },
    });
    state.queue.claimNext({ consumer: "runner", leaseMs: 500 });
    state.queue.beginDelivery(retryable.id, "runner");
    state.queue.recordReceipt(retryable.id, "daria", { turnId: "turn-pre-work" });
    const retrySafe = new StructuredTurnOutcomeMonitor(state.queue, {
      messageId: retryable.id,
      attemptNumber: 1,
      reportedBy: "daria",
      streamId: "app-server-turn",
      retryAfterMs: 0,
    }).consume({
      method: "turn/completed",
      params: {
        turn: {
          id: "turn-pre-work",
          status: "failed",
          itemsView: "full",
          items: [{ id: "input-1", type: "userMessage", content: [] }],
          error: { codexErrorInfo: "serverOverloaded" },
        },
      },
    });
    assert.equal(retrySafe?.outcome, "retry_safe");
    assert.equal(state.queue.getMessage(retryable.id)?.state, "queued");
    assert.equal(
      state.queue.inspect(retryable.id).interruptions[0]?.workStarted,
      false,
    );

    state.queue.setWorkerAvailability("beavis", "idle");
    const unclassified = state.queue.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "Do not infer safety from partial event history." },
    });
    state.queue.claimNext({
      consumer: "runner",
      leaseMs: 500,
      recipient: "beavis",
    });
    state.queue.beginDelivery(unclassified.id, "runner");
    state.queue.recordReceipt(unclassified.id, "beavis");
    const unknown = new StructuredTurnOutcomeMonitor(state.queue, {
      messageId: unclassified.id,
      attemptNumber: 1,
      reportedBy: "beavis",
      streamId: "partial-stream",
      historyComplete: false,
    }).consume({
      type: "turn.failed",
      turn_id: "turn-partial",
      error: { code: "serverOverloaded" },
    });
    assert.equal(unknown?.outcome, "escalated");
    assert.equal(
      state.queue.inspect(unclassified.id).interruptions[0]?.workStarted,
      null,
    );
  } finally {
    state.cleanup();
  }
});

test("busy workers keep queued work and an injected prompt without a receipt fails visibly", async () => {
  const state = fixture();
  try {
    state.sessions.configureWorker("butthead", state.worktree);
    state.queue.setWorkerAvailability("butthead", "busy");
    const busyMessage = state.queue.enqueue({
      sender: "morpheus",
      recipient: "butthead",
      payload: { text: "Wait until idle." },
    });
    const terminal = new FakeTerminal();
    terminal.running.add("butthead");
    const coordinator = new DeliveryCoordinator(state.queue, state.sessions, terminal, {
      consumer: "runner",
      receiptTimeoutMs: 5,
      pollMs: 1,
    });
    assert.equal((await coordinator.deliverOnce()).outcome, "empty");
    assert.equal(state.queue.getMessage(busyMessage.id)?.state, "queued");

    state.tick();
    state.queue.setWorkerAvailability("butthead", "idle");
    const failed = await coordinator.deliverOnce();
    assert.equal(failed.outcome, "failed");
    assert.equal(state.queue.getMessage(busyMessage.id)?.state, "failed");
    assert.equal(state.queue.listEscalations({ kind: "delivery_failure" }).length, 1);
  } finally {
    state.cleanup();
  }
});

test("tmux adapter hides start, resume, attach, and paste mechanics behind worker names", () => {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  let exists = false;
  const execute: CommandExecutor = (command, args, options) => {
    calls.push({ command, args, input: options?.input as string | undefined });
    if (args.includes("has-session")) {
      return { status: exists ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args.includes("new-session")) {
      exists = true;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const terminal = new TmuxWorkerTerminal({ execute });
  const worker: WorkerSessionRecord = {
    name: "beavis",
    worktreePath: "/tmp/work tree",
    sessionId: SESSION_A,
    transcriptPath: null,
    hookRevision: "1",
    lastEvent: "SessionStart",
    lastEventAt: 1,
    activeTurnId: null,
    activeMessageId: null,
    updatedAt: 1,
  };
  terminal.start(worker);
  terminal.inject("beavis", "prompt with\nmultiple lines");
  terminal.attach("beavis");

  const start = calls.find((call) => call.args.includes("new-session"));
  assert.match(start?.args.at(-1) ?? "", /codex.*resume.*11111111/);
  assert.match(start?.args.at(-1) ?? "", /'\/tmp\/work tree'/);
  assert.equal(
    calls.find((call) => call.args.includes("load-buffer"))?.input,
    "prompt with\nmultiple lines",
  );
  assert.ok(calls.some((call) => call.args.includes("paste-buffer")));
  assert.ok(calls.some((call) => call.args.includes("send-keys")));
  assert.ok(calls.some((call) => call.args.includes("attach-session")));
});

test("the party CLI configures named worktrees without storing them in Git", () => {
  const state = fixture();
  try {
    const script = join(process.cwd(), "dispatcher", "party.ts");
    const configured = spawnSync(
      process.execPath,
      [script, "--database", state.queue.databasePath, "configure", "beavis", state.worktree],
      { encoding: "utf8" },
    );
    assert.equal(configured.status, 0, configured.stderr);
    assert.match(configured.stdout, new RegExp(`beavis: ${state.worktree}`));

    const listed = spawnSync(
      process.execPath,
      [script, "--database", state.queue.databasePath, "agents"],
      { encoding: "utf8" },
    );
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /beavis: asleep; .*; no saved Codex session/);
  } finally {
    state.cleanup();
  }
});

test("the party CLI consumes a structured Codex JSONL terminal outcome", () => {
  const state = fixture();
  try {
    state.queue.setWorkerAvailability("beavis", "idle");
    const message = state.queue.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "Complete only from the event stream." },
    });
    state.queue.claimNext({ consumer: "runner", leaseMs: 500 });
    state.queue.beginDelivery(message.id, "runner");
    state.queue.recordReceipt(message.id, "beavis");

    const script = join(process.cwd(), "dispatcher", "party.ts");
    const outcome = spawnSync(
      process.execPath,
      [
        script,
        "--database",
        state.queue.databasePath,
        "turn-events",
        message.id,
        "--reported-by",
        "beavis",
        "--attempt",
        "1",
        "--stream-id",
        "cli-stream",
      ],
      {
        encoding: "utf8",
        input:
          '{"type":"turn.started"}\n' +
          '{"type":"turn.completed","turn_id":"turn-cli"}\n',
      },
    );
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(JSON.parse(outcome.stdout).outcome, "completed");
    assert.equal(state.queue.getMessage(message.id)?.state, "completed");
  } finally {
    state.cleanup();
  }
});

test("party deliver runs the correlated Codex JSON stream without a manual event step", () => {
  const state = fixture();
  try {
    state.sessions.configureWorker("beavis", state.worktree);
    state.sessions.registerSession({
      name: "beavis",
      cwd: state.worktree,
      sessionId: SESSION_A,
      hookRevision: "2",
    });
    state.queue.setWorkerAvailability("beavis", "idle");

    const fakeCodex = join(state.directory, "codex");
    const codexLog = join(state.directory, "codex.log");
    const queueUrl = pathToFileURL(join(process.cwd(), "dispatcher", "queue.ts")).href;
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { DispatcherQueue } from ${JSON.stringify(queueUrl)};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString("utf8");
const header = prompt.split("\\n", 1)[0];
const encoded = header.slice("[AFTER_PARTY_HANDOFF_V1:".length, -1);
const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
const queue = new DispatcherQueue(process.env.PARTY_DISPATCHER_DB);
queue.recordReceipt(envelope.messageId, envelope.recipient, { turnId: "fake-turn" });
queue.close();
appendFileSync(process.env.PARTY_CODEX_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: process.env.PARTY_THREAD_ID }));
console.log(JSON.stringify({ type: "turn.started" }));
if (prompt.includes("structured retry")) {
  console.log(JSON.stringify({ type: "turn.failed", turn_id: "retry-turn", error: { code: "serverOverloaded" } }));
} else if (prompt.includes("structured escalation")) {
  console.log(JSON.stringify({ type: "item.started", item: { id: "work-1", type: "reasoning" } }));
  console.log(JSON.stringify({ type: "turn.failed", turn_id: "failed-turn", error: { code: "serverOverloaded" } }));
} else {
  console.log(JSON.stringify({ type: "turn.completed", turn_id: "completed-turn" }));
}
`,
      "utf8",
    );
    chmodSync(fakeCodex, 0o755);
    const script = join(process.cwd(), "dispatcher", "party.ts");
    let consumer = 0;
    const deliver = () => spawnSync(
      process.execPath,
      [
        script,
        "--database",
        state.queue.databasePath,
        "deliver",
        "--consumer",
        `runner-${consumer += 1}`,
        "--lease-ms",
        "500",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${state.directory}:${process.env.PATH ?? ""}`,
          PARTY_CODEX_LOG: codexLog,
          PARTY_THREAD_ID: SESSION_A,
        },
      },
    );

    const completed = state.queue.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "structured completion" },
    });
    const completedRun = deliver();
    assert.equal(completedRun.status, 0, completedRun.stderr);
    assert.equal(JSON.parse(completedRun.stdout).outcome, "completed");
    assert.equal(state.queue.getMessage(completed.id)?.state, "completed");

    const retry = state.queue.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "structured retry" },
    });
    const retryRun = deliver();
    assert.equal(retryRun.status, 0, retryRun.stderr);
    assert.equal(JSON.parse(retryRun.stdout).outcome, "retry_safe");
    assert.equal(state.queue.getMessage(retry.id)?.state, "queued");

    const escalation = state.queue.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "structured escalation" },
    });
    const escalationRun = deliver();
    assert.equal(escalationRun.status, 1, escalationRun.stderr);
    assert.equal(JSON.parse(escalationRun.stdout).outcome, "failed");
    assert.equal(state.queue.getMessage(escalation.id)?.state, "failed");
    assert.equal(
      state.queue.inspect(escalation.id).interruptions[0]?.workStarted,
      true,
    );

    const invocations = readFileSync(codexLog, "utf8").trim().split("\n");
    assert.equal(invocations.length, 3);
    assert.deepEqual(JSON.parse(invocations[0]), [
      "exec",
      "resume",
      "--json",
      SESSION_A,
      "-",
    ]);
  } finally {
    state.cleanup();
  }
});
