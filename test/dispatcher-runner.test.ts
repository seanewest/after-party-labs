import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("lifecycle hooks register identity, separate receipt from completion, and suppress retries", () => {
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
      reason: `Dispatcher message ${enqueued.id} was already receipted; duplicate processing is suppressed.`,
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
    assert.equal(state.queue.getMessage(enqueued.id)?.state, "completed");
    assert.equal(state.queue.getWorker("beavis").availability, "idle");
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

test("sleeping workers resume their saved session and receipt delivery before completion", async () => {
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
    terminal.onStart = () => {
      state.tick();
      lifecycle.handle({
        hook_event_name: "SessionStart",
        session_id: SESSION_B,
        cwd: state.worktree,
        source: "resume",
      });
    };
    terminal.onInject = (_name, prompt) => {
      state.tick();
      lifecycle.handle({
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION_B,
        cwd: state.worktree,
        turn_id: "delivery-turn",
        prompt,
      });
    };
    const coordinator = new DeliveryCoordinator(
      state.queue,
      state.sessions,
      terminal,
      { consumer: "runner", leaseMs: 500, pollMs: 1 },
    );
    const result = await coordinator.deliverOnce();
    assert.equal(result.outcome, "receipted");
    assert.equal(terminal.starts[0]?.sessionId, SESSION_B);
    assert.equal(terminal.injections.length, 1);
    assert.equal(state.queue.getMessage(message.id)?.state, "acknowledged");

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
