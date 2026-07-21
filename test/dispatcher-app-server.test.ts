import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexAppServerClient,
  CodexAppServerError,
  type CodexAppServerNotification,
} from "../dispatcher/app-server-client.ts";
import { DispatcherQueue } from "../dispatcher/queue.ts";
import { WorkerSessionStore } from "../dispatcher/session-store.ts";
import { SharedWorkerDeliveryPrototype } from "../dispatcher/shared-worker-prototype.ts";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "turn-shared-63";

class FakeSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (typeof message.id !== "number") {
      return;
    }
    const method = String(message.method);
    const result =
      method === "initialize"
        ? { userAgent: "fake" }
        : method === "thread/resume"
          ? { thread: { id: THREAD_ID } }
          : method === "thread/start"
            ? { thread: { id: THREAD_ID } }
            : method === "turn/start"
              ? { turn: { id: TURN_ID } }
              : method === "turn/steer"
                ? { turnId: TURN_ID }
                : {};
    queueMicrotask(() => this.message({ id: message.id, result }));
  }

  close(): void {
    this.readyState = 3;
  }

  message(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test("app-server client initializes JSON-RPC and shares start, steer, and completion", async () => {
  const socket = new FakeSocket();
  const client = await CodexAppServerClient.connect("ws://127.0.0.1:4500", {
    socketFactory: () => socket,
  });
  const notifications: CodexAppServerNotification[] = [];
  client.onNotification((notification) => notifications.push(notification));

  assert.equal((await client.resumeThread(THREAD_ID, "/tmp/worktree")).id, THREAD_ID);
  assert.equal(
    (await client.startTurn(THREAD_ID, [{ type: "text", text: "work" }])).id,
    TURN_ID,
  );
  assert.equal(
    await client.steerTurn(THREAD_ID, TURN_ID, [
      { type: "localImage", path: "/tmp/screenshot.png" },
      { type: "text", text: "use this screenshot" },
    ]),
    TURN_ID,
  );

  const completion = client.waitForTurnCompletion(TURN_ID, 1_000);
  socket.message({
    method: "turn/completed",
    params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" } },
  });
  assert.equal((await completion).method, "turn/completed");
  assert.equal(notifications.at(-1)?.method, "turn/completed");
  assert.deepEqual(
    socket.sent.map((message) => message.method),
    ["initialize", "initialized", "thread/resume", "turn/start", "turn/steer"],
  );
  client.close();
});

test("app-server client fails closed on non-local experimental endpoints", async () => {
  await assert.rejects(
    CodexAppServerClient.connect("wss://example.com/app-server"),
    (error: unknown) =>
      error instanceof CodexAppServerError && /only a local/.test(error.message),
  );
});

test("app-server client explicitly rejects unsupported server requests", async () => {
  const socket = new FakeSocket();
  const client = await CodexAppServerClient.connect("ws://127.0.0.1:4500", {
    socketFactory: () => socket,
  });
  const notifications: CodexAppServerNotification[] = [];
  client.onNotification((notification) => notifications.push(notification));
  socket.message({
    id: "approval-1",
    method: "item/tool/requestUserInput",
    params: { threadId: THREAD_ID },
  });
  await Promise.resolve();
  const response = socket.sent.at(-1);
  assert.equal(response?.id, "approval-1");
  assert.match(
    String((response?.error as Record<string, unknown>)?.message),
    /does not handle/,
  );
  assert.equal(
    notifications.at(-1)?.method,
    "after-party/server-request-rejected",
  );
  client.close();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "after-party-shared-worker-"));
  const worktree = join(directory, "worktree");
  mkdirSync(join(worktree, ".git"), { recursive: true });
  const databasePath = join(directory, "dispatcher.sqlite");
  const queue = new DispatcherQueue(databasePath);
  const sessions = new WorkerSessionStore(databasePath);
  sessions.configureWorker("daria", worktree);
  sessions.registerSession({
    name: "daria",
    cwd: worktree,
    sessionId: THREAD_ID,
    hookRevision: "test",
  });
  queue.setWorkerAvailability("daria", "idle");
  return {
    directory,
    queue,
    sessions,
    cleanup() {
      sessions.close();
      queue.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

class FakeSharedClient {
  listener: ((notification: CodexAppServerNotification) => void) | null = null;
  terminal: CodexAppServerNotification = {
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: "completed", itemsView: "full", items: [] },
    },
  };
  waitError: Error | null = null;
  beforeTerminal: CodexAppServerNotification[] = [];

  onNotification(listener: (notification: CodexAppServerNotification) => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  async resumeThread() {
    return { id: THREAD_ID };
  }

  async startTurn() {
    return { id: TURN_ID };
  }

  async waitForTurnCompletion() {
    for (const notification of this.beforeTerminal) {
      this.listener?.(notification);
    }
    this.listener?.({
      method: "item/started",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "agentMessage" },
      },
    });
    if (this.waitError) {
      throw this.waitError;
    }
    this.listener?.(this.terminal);
    return this.terminal;
  }

  close() {}
}

test("shared worker prototype persists app-server receipt and structured completion", async () => {
  const state = fixture();
  const client = new FakeSharedClient();
  client.beforeTerminal.push({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "unrelated-human-turn", status: "failed", error: { code: "other" } },
    },
  });
  try {
    const enqueued = state.queue.enqueue({
      sender: "morpheus",
      recipient: "daria",
      payload: { text: "handle the shared turn" },
    });
    const result = await new SharedWorkerDeliveryPrototype(state.queue, state.sessions, {
      endpoint: "ws://127.0.0.1:4500",
      recipient: "daria",
      connect: async () => client,
    }).deliverOnce();

    assert.equal(result.outcome, "completed");
    assert.equal(state.queue.getMessage(enqueued.id)?.state, "completed");
    assert.deepEqual(state.queue.inspect(enqueued.id).receipt?.details, {
      source: "codex-app-server",
      endpoint: "ws://127.0.0.1:4500",
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
  } finally {
    state.cleanup();
  }
});

test("shared worker prototype escalates a lost stream after structured receipt", async () => {
  const state = fixture();
  const client = new FakeSharedClient();
  client.waitError = new Error("socket disappeared");
  try {
    const enqueued = state.queue.enqueue({
      sender: "morpheus",
      recipient: "daria",
      payload: { text: "handle the interrupted turn" },
    });
    const result = await new SharedWorkerDeliveryPrototype(state.queue, state.sessions, {
      endpoint: "ws://localhost:4500",
      recipient: "daria",
      connect: async () => client,
    }).deliverOnce();

    assert.equal(result.outcome, "escalated");
    assert.equal(state.queue.getMessage(enqueued.id)?.state, "failed");
    assert.equal(state.queue.inspect(enqueued.id).interruptions.length, 1);
  } finally {
    state.cleanup();
  }
});
