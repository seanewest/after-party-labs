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

test("a structured pre-work capacity interruption requeues the same receipted message", () => {
  const state = fixture();
  try {
    const first = new DispatcherQueue(state.databasePath, { now: state.now });
    const message = first.enqueue({
      sender: "morpheus",
      recipient: "cornholio",
      payload: { text: "Resume Task #36" },
    });
    first.claimNext({ consumer: "runner-a", leaseMs: 500 });
    first.beginDelivery(message.id, "runner-a");
    first.recordReceipt(message.id, "cornholio", { turnId: "turn-1" });
    first.acknowledge(message.id);

    const interrupted = first.reportTurnInterruption({
      messageId: message.id,
      reportedBy: "cornholio",
      reason: "Selected model is at capacity",
      workStarted: false,
      retrySafe: true,
      retryAfterMs: 200,
      dedupeKey: "turn:turn-1:capacity",
      details: { event: "turn.failed", code: "model_capacity" },
    });
    assert.equal(interrupted.message.state, "queued");
    assert.equal(interrupted.message.availableAt, 1_200);
    assert.equal(interrupted.interruption.disposition, "retry_safe");
    assert.equal(interrupted.interruption.interruptedAttemptNumber, 1);
    assert.equal(first.inspect(message.id).receipt?.acceptedAt, 1_000);
    first.close();

    state.setTime(1_199);
    const restarted = new DispatcherQueue(state.databasePath, { now: state.now });
    assert.equal(restarted.claimNext({ consumer: "runner-b", leaseMs: 500 }), null);
    state.setTime(1_200);
    const retry = restarted.claimNext({ consumer: "runner-b", leaseMs: 500 });
    assert.equal(retry?.id, message.id);
    assert.equal(retry?.attemptCount, 2);
    restarted.beginDelivery(message.id, "runner-b");
    assert.equal(restarted.recordReceipt(message.id, "cornholio").state, "receipted");
    restarted.acknowledge(message.id);
    restarted.complete(message.id);

    const duplicate = restarted.reportTurnInterruption({
      messageId: message.id,
      reportedBy: "cornholio",
      reason: "duplicate event",
      workStarted: false,
      retrySafe: true,
      dedupeKey: "turn:turn-1:capacity",
    });
    assert.equal(duplicate.interruption.id, interrupted.interruption.id);
    assert.equal(duplicate.message.state, "completed");
    assert.equal(restarted.inspect(message.id).interruptions.length, 1);
    restarted.close();
  } finally {
    state.cleanup();
  }
});

test("an ambiguous post-receipt interruption fails closed and escalates exactly once", () => {
  const state = fixture();
  try {
    const first = new DispatcherQueue(state.databasePath, { now: state.now });
    const message = first.enqueue({
      sender: "morpheus",
      recipient: "beavis",
      payload: { text: "Continue the implementation" },
      sourceUrl: "https://github.com/example/repo/issues/44",
    });
    first.claimNext({ consumer: "runner-a", leaseMs: 500 });
    first.beginDelivery(message.id, "runner-a");
    first.recordReceipt(message.id, "beavis", { turnId: "turn-2" });

    const interrupted = first.reportTurnInterruption({
      messageId: message.id,
      reportedBy: "beavis",
      reason: "Connection ended after tool activity",
      workStarted: true,
      retrySafe: false,
      dedupeKey: "turn:turn-2:connection",
      details: { event: "error", toolActivityObserved: true },
    });
    assert.equal(interrupted.message.state, "failed");
    assert.equal(interrupted.interruption.disposition, "escalated");
    assert.equal(interrupted.escalation?.kind, "delivery_failure");
    assert.equal(interrupted.escalation?.subjectAgent, "beavis");
    assert.equal(first.claimNext({ consumer: "runner-b", leaseMs: 500 }), null);
    first.close();

    const restarted = new DispatcherQueue(state.databasePath, { now: state.now });
    const duplicate = restarted.reportTurnInterruption({
      messageId: message.id,
      reportedBy: "beavis",
      reason: "duplicate event",
      workStarted: null,
      retrySafe: false,
      dedupeKey: "turn:turn-2:connection",
    });
    assert.equal(duplicate.interruption.id, interrupted.interruption.id);
    assert.equal(duplicate.escalation?.id, interrupted.escalation?.id);
    assert.equal(restarted.listEscalations({ status: "open" }).length, 1);
    assert.equal(restarted.inspect(message.id).interruptions.length, 1);
    restarted.close();
  } finally {
    state.cleanup();
  }
});

test("turn interruption recovery rejects unsafe retries and terminal message states", () => {
  const state = fixture();
  try {
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const message = queue.enqueue({
      sender: "morpheus",
      recipient: "daria",
      payload: { text: "Do not replay ambiguously" },
    });
    queue.claimNext({ consumer: "runner-a", leaseMs: 500 });
    queue.beginDelivery(message.id, "runner-a");
    queue.recordReceipt(message.id, "daria");
    assert.throws(
      () =>
        queue.reportTurnInterruption({
          messageId: message.id,
          reportedBy: "daria",
          reason: "Some work may have started",
          workStarted: null,
          retrySafe: true,
          dedupeKey: "turn:unsafe",
        }),
      /requires structured evidence/,
    );
    queue.acknowledge(message.id);
    queue.complete(message.id);
    assert.throws(
      () =>
        queue.reportTurnInterruption({
          messageId: message.id,
          reportedBy: "daria",
          reason: "Too late",
          workStarted: false,
          retrySafe: true,
          dedupeKey: "turn:completed",
        }),
      InvalidTransitionError,
    );

    const cancelled = queue.enqueue({
      sender: "morpheus",
      recipient: "daria",
      payload: { text: "Cancelled" },
    });
    queue.cancel(cancelled.id);
    assert.throws(
      () => queue.recordReceipt(cancelled.id, "daria"),
      InvalidTransitionError,
    );
    queue.close();
  } finally {
    state.cleanup();
  }
});

test("worker availability is durable, typed, and protected from stale observations", () => {
  const state = fixture();
  try {
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    assert.deepEqual(
      queue.listWorkers().map((worker) => [worker.name, worker.availability]),
      [
        ["beavis", "unknown"],
        ["butthead", "unknown"],
        ["cornholio", "unknown"],
        ["daria", "unknown"],
        ["morpheus", "unknown"],
      ],
    );
    assert.throws(
      () => queue.setWorkerAvailability("beavis", "unavailable"),
      /require a reason/,
    );
    assert.equal(
      queue.setWorkerAvailability("beavis", "busy", { observedAt: 900 }).availability,
      "busy",
    );
    assert.equal(
      queue.setWorkerAvailability("beavis", "asleep", { observedAt: 800 }).availability,
      "busy",
    );
    assert.equal(
      queue.setWorkerAvailability("beavis", "unavailable", {
        observedAt: 1_000,
        reason: "worktree was removed",
      }).reason,
      "worktree was removed",
    );
    queue.close();

    const reopened = new DispatcherQueue(state.databasePath, { now: state.now });
    assert.equal(reopened.getWorker("beavis").availability, "unavailable");
    assert.equal(reopened.getWorker("beavis").reason, "worktree was removed");
    reopened.close();
  } finally {
    state.cleanup();
  }
});

test("unavailable workers retain queued work until a newer observation makes them eligible", () => {
  const state = fixture();
  try {
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const message = queue.enqueue({
      sender: "morpheus",
      recipient: "butthead",
      payload: { text: "Wait safely" },
    });
    queue.setWorkerAvailability("butthead", "unavailable", {
      reason: "configured worktree is missing",
    });
    assert.equal(queue.claimNext({ consumer: "runner-a", leaseMs: 100 }), null);
    assert.equal(queue.getMessage(message.id)?.state, "queued");

    state.setTime(1_100);
    queue.setWorkerAvailability("butthead", "idle");
    assert.equal(
      queue.claimNext({ consumer: "runner-a", leaseMs: 100 })?.id,
      message.id,
    );
    queue.close();
  } finally {
    state.cleanup();
  }
});

test("escalations persist, deduplicate, filter, inspect, and resolve independently", () => {
  const state = fixture();
  try {
    const first = new DispatcherQueue(state.databasePath, { now: state.now });
    const message = first.enqueue({
      sender: "daria",
      recipient: "morpheus",
      payload: { text: "Ambiguous owner" },
    });
    const escalation = first.createEscalation({
      kind: "worker_unavailable",
      requestedBy: "daria",
      subjectAgent: "beavis",
      messageId: message.id,
      summary: "Beavis cannot resume the configured session",
      details: { attempts: 3 },
      dedupeKey: "worker-unavailable:beavis:session-1",
      sourceUrl: "https://github.com/example/repo/issues/1",
    });
    const duplicate = first.createEscalation({
      kind: "manual",
      requestedBy: "cornholio",
      summary: "This duplicate must not replace the original",
      dedupeKey: "worker-unavailable:beavis:session-1",
    });
    assert.equal(duplicate.id, escalation.id);
    first.close();

    state.setTime(2_000);
    const reopened = new DispatcherQueue(state.databasePath, { now: state.now });
    assert.equal(reopened.getEscalation(escalation.id)?.status, "open");
    assert.deepEqual(reopened.getEscalation(escalation.id)?.details, { attempts: 3 });
    assert.equal(
      reopened.listEscalations({ status: "open", subjectAgent: "beavis" }).length,
      1,
    );
    const resolved = reopened.resolveEscalation(
      escalation.id,
      "The worktree was restored",
    );
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolution, "The worktree was restored");
    assert.equal(reopened.resolveEscalation(escalation.id, "ignored").resolution, "The worktree was restored");
    assert.equal(reopened.listEscalations({ status: "open" }).length, 0);
    reopened.close();
  } finally {
    state.cleanup();
  }
});

test("escalation contracts reject incomplete unavailable-worker and message references", () => {
  const state = fixture();
  try {
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    assert.throws(
      () =>
        queue.createEscalation({
          kind: "worker_unavailable",
          requestedBy: "morpheus",
          summary: "Missing subject",
        }),
      /requires a subject agent/,
    );
    assert.throws(
      () =>
        queue.createEscalation({
          kind: "delivery_failure",
          requestedBy: "morpheus",
          summary: "Unknown message",
          messageId: "missing-message",
        }),
      /does not exist/,
    );
    queue.close();
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
