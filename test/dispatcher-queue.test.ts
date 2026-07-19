import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultDispatcherDatabasePath } from "../dispatcher/paths.ts";
import {
  DispatcherQueue,
  InvalidTransitionError,
} from "../dispatcher/queue.ts";
import { AGENT_NAMES, parseAgentName } from "../dispatcher/registry.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "after-party-dispatcher-"));
  const databasePath = join(directory, "queue.sqlite");
  let currentTime = 1_000;
  const now = () => currentTime;
  return {
    databasePath,
    now,
    setTime(value: number) {
      currentTime = value;
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("the named registry accepts only the five durable worker identities", () => {
  assert.deepEqual(AGENT_NAMES, [
    "beavis",
    "butthead",
    "cornholio",
    "daria",
    "morpheus",
  ]);
  assert.equal(parseAgentName(" MORPHEUS "), "morpheus");
  assert.throws(() => parseAgentName("unknown"), /Expected one of/);
});

test("the default database path stays outside the repository and supports overrides", () => {
  assert.equal(
    defaultDispatcherDatabasePath({
      PARTY_DISPATCHER_DB: "/tmp/custom.sqlite",
    }),
    "/tmp/custom.sqlite",
  );
  assert.equal(
    defaultDispatcherDatabasePath({ XDG_STATE_HOME: "/tmp/state" }),
    "/tmp/state/after-party/dispatcher.sqlite",
  );
});

test("messages persist across restarts and a dedupe key returns the original envelope", () => {
  const state = fixture();
  try {
    const firstQueue = new DispatcherQueue(state.databasePath, { now: state.now });
    const original = firstQueue.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { kind: "agent_message", text: "Review the PR" },
      dedupeKey: "github:review-comment:123",
      correlationId: "pr:41",
      sourceUrl: "https://github.com/example/repo/pull/41#discussion_r123",
    });
    firstQueue.close();

    state.setTime(2_000);
    const reopened = new DispatcherQueue(state.databasePath, { now: state.now });
    const duplicate = reopened.enqueue({
      sender: "daria",
      recipient: "cornholio",
      payload: { text: "This different payload must not replace the original" },
      dedupeKey: "github:review-comment:123",
    });

    assert.equal(duplicate.id, original.id);
    assert.equal(duplicate.sender, "morpheus");
    assert.equal(duplicate.recipient, "beavis");
    assert.deepEqual(duplicate.payload, {
      kind: "agent_message",
      text: "Review the PR",
    });
    assert.equal(reopened.listMessages().length, 1);
    reopened.close();
  } finally {
    state.cleanup();
  }
});

test("the full receipt, acknowledgement, and completion path is durable and idempotent", () => {
  const state = fixture();
  try {
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const enqueued = queue.enqueue({
      sender: "morpheus",
      recipient: "daria",
      payload: { text: "Please inspect the Story" },
    });
    const leased = queue.claimNext({ consumer: "runner-a", leaseMs: 500 });
    assert.equal(leased?.id, enqueued.id);
    assert.equal(leased?.attemptCount, 1);
    assert.equal(leased?.state, "leased");
    assert.equal(queue.beginDelivery(enqueued.id, "runner-a").state, "delivering");

    const receipted = queue.recordReceipt(enqueued.id, "daria", {
      sessionId: "session-123",
    });
    assert.equal(receipted.state, "receipted");
    assert.equal(queue.recordReceipt(enqueued.id, "daria").state, "receipted");
    assert.equal(queue.acknowledge(enqueued.id).state, "acknowledged");
    assert.equal(queue.acknowledge(enqueued.id).state, "acknowledged");
    assert.equal(queue.complete(enqueued.id).state, "completed");
    assert.equal(queue.complete(enqueued.id).state, "completed");

    const inspection = queue.inspect(enqueued.id);
    assert.equal(inspection.receipt?.recipient, "daria");
    assert.deepEqual(inspection.receipt?.details, { sessionId: "session-123" });
    assert.equal(inspection.attempts.length, 1);
    assert.equal(inspection.attempts[0].outcome, "receipted");
    assert.equal(queue.claimNext({ consumer: "runner-b", leaseMs: 500 }), null);
    queue.close();
  } finally {
    state.cleanup();
  }
});

test("separate consumers cannot claim the same queued message", () => {
  const state = fixture();
  try {
    const first = new DispatcherQueue(state.databasePath, { now: state.now });
    const second = new DispatcherQueue(state.databasePath, { now: state.now });
    const message = first.enqueue({
      sender: "beavis",
      recipient: "butthead",
      payload: { text: "One consumer only" },
    });

    assert.equal(
      first.claimNext({ consumer: "runner-a", leaseMs: 500 })?.id,
      message.id,
    );
    assert.equal(second.claimNext({ consumer: "runner-b", leaseMs: 500 }), null);
    first.close();
    second.close();
  } finally {
    state.cleanup();
  }
});

test("failed messages require an explicit retry and queued messages can be cancelled", () => {
  const state = fixture();
  try {
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const message = queue.enqueue({
      sender: "cornholio",
      recipient: "morpheus",
      payload: { text: "Handle a failure" },
    });
    queue.claimNext({ consumer: "runner-a", leaseMs: 500 });
    assert.equal(queue.fail(message.id, "runner-a", "terminal unavailable").state, "failed");
    assert.equal(queue.claimNext({ consumer: "runner-b", leaseMs: 500 }), null);
    assert.equal(queue.retry(message.id).state, "queued");
    assert.equal(queue.cancel(message.id).state, "cancelled");
    assert.throws(() => queue.retry(message.id), InvalidTransitionError);
    queue.close();
  } finally {
    state.cleanup();
  }
});

test("a crash before external send expires the lease and preserves the message ID", () => {
  const state = fixture();
  try {
    const first = new DispatcherQueue(state.databasePath, { now: state.now });
    const original = first.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "Crash before send" },
    });
    first.claimNext({ consumer: "crashed-runner", leaseMs: 100 });
    first.close();

    state.setTime(1_100);
    const restarted = new DispatcherQueue(state.databasePath, { now: state.now });
    const retry = restarted.claimNext({ consumer: "new-runner", leaseMs: 100 });
    assert.equal(retry?.id, original.id);
    assert.equal(retry?.attemptCount, 2);
    assert.deepEqual(
      restarted.inspect(original.id).attempts.map((attempt) => attempt.outcome),
      ["lease_expired", null],
    );
    restarted.close();
  } finally {
    state.cleanup();
  }
});

test("a crash after prompt acceptance but before a durable receipt permits a recognizable retry", () => {
  const state = fixture();
  try {
    const first = new DispatcherQueue(state.databasePath, { now: state.now });
    const original = first.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "The same ID may appear twice" },
    });
    first.claimNext({ consumer: "crashed-runner", leaseMs: 100 });
    first.beginDelivery(original.id, "crashed-runner");
    first.close();

    state.setTime(1_101);
    const restarted = new DispatcherQueue(state.databasePath, { now: state.now });
    const retry = restarted.claimNext({ consumer: "new-runner", leaseMs: 100 });
    assert.equal(retry?.id, original.id);
    assert.equal(retry?.attemptCount, 2);
    restarted.close();
  } finally {
    state.cleanup();
  }
});

test("a durable recipient receipt suppresses retry after the queue process crashes", () => {
  const state = fixture();
  try {
    const queueProcess = new DispatcherQueue(state.databasePath, { now: state.now });
    const recipientProcess = new DispatcherQueue(state.databasePath, { now: state.now });
    const message = queueProcess.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "Receipt survives acknowledgement crash" },
    });
    queueProcess.claimNext({ consumer: "runner-a", leaseMs: 100 });
    queueProcess.beginDelivery(message.id, "runner-a");
    recipientProcess.recordReceipt(message.id, "beavis", { accepted: true });
    queueProcess.close();
    recipientProcess.close();

    state.setTime(2_000);
    const restarted = new DispatcherQueue(state.databasePath, { now: state.now });
    assert.equal(restarted.claimNext({ consumer: "runner-b", leaseMs: 100 }), null);
    assert.equal(restarted.inspect(message.id).message.state, "receipted");
    assert.equal(restarted.acknowledge(message.id).state, "acknowledged");
    restarted.close();
  } finally {
    state.cleanup();
  }
});

test("invalid owners and transitions fail closed", () => {
  const state = fixture();
  try {
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const message = queue.enqueue({
      sender: "daria",
      recipient: "morpheus",
      payload: { text: "Do not steal this lease" },
    });
    queue.claimNext({ consumer: "runner-a", leaseMs: 500 });
    assert.throws(
      () => queue.beginDelivery(message.id, "runner-b"),
      /leased to runner-a/,
    );
    assert.throws(() => queue.acknowledge(message.id), InvalidTransitionError);
    assert.throws(() => queue.recordReceipt(message.id, "beavis"), /addressed to morpheus/);
    queue.close();
  } finally {
    state.cleanup();
  }
});
