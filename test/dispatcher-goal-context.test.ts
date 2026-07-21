import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GoalContextError,
  GoalContextStore,
  parseGoalReference,
} from "../dispatcher/goal-context.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "after-party-goal-context-"));
  let now = 1_000;
  let sequence = 0;
  const store = new GoalContextStore(join(directory, "dispatcher.sqlite"), {
    now: () => ++now,
    id: () => `id-${++sequence}`,
  });
  return {
    directory,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("one GitHub goal keeps one stable context identity", () => {
  const context = fixture();
  try {
    const first = context.store.createOrGet({
      repository: "SeanEWest/After-Party-Labs",
      issueNumber: 34,
      worktreePath: context.directory,
      branch: "agent/goal-34",
      threadId: "thread-one",
    });
    const duplicate = context.store.createOrGet({
      repository: "seanewest/after-party-labs",
      issueNumber: 34,
      worktreePath: "/ignored/after/first/insert",
      branch: "ignored",
      threadId: "ignored",
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.worktreePath, first.worktreePath);
    assert.equal(duplicate.threadId, "thread-one");

    const running = context.store.updateRuntime(first.id, {
      state: "running",
      appEndpoint: "ws://127.0.0.1:43135",
      contextUrl: `http://127.0.0.1:43134/contexts/${first.id}`,
      appServerPid: 123,
      gatewayPid: 456,
      incrementGeneration: true,
    });
    assert.equal(running.generation, 1);
    assert.equal(running.state, "running");

    context.store.close();
    const reopened = new GoalContextStore(
      join(context.directory, "dispatcher.sqlite"),
    );
    assert.deepEqual(reopened.requireByGoal(parseGoalReference("seanewest/after-party-labs#34")), running);
    reopened.close();
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test("goal events deduplicate, order deterministically, and serialize claims", () => {
  const context = fixture();
  try {
    const goal = context.store.createOrGet({
      repository: "seanewest/after-party-labs",
      issueNumber: 34,
      worktreePath: context.directory,
      branch: "agent/goal-34",
    });
    const later = context.store.enqueueEvent({
      contextId: goal.id,
      sourceId: "github:review:2",
      sourceKind: "review",
      sourceVersion: "2",
      sourceTime: 200,
      payload: { text: "later" },
    });
    const first = context.store.enqueueEvent({
      contextId: goal.id,
      sourceId: "github:check:1",
      sourceKind: "check",
      sourceVersion: "1",
      sourceTime: 100,
      payload: { text: "first" },
    });
    assert.equal(
      context.store.enqueueEvent({
        contextId: goal.id,
        sourceId: first.sourceId,
        sourceKind: "check",
        sourceVersion: "1",
        sourceTime: 100,
        payload: { text: "first" },
      }).id,
      first.id,
    );

    const claimed = context.store.claimNextOrdered(goal.id, "runner-a");
    assert.equal(claimed?.id, first.id);
    assert.equal(context.store.claimNextOrdered(goal.id, "runner-b"), null);
    assert.equal(
      context.store.completeEvent(first.id, "runner-a", "applied").state,
      "consumed",
    );
    assert.equal(context.store.finishOperation(goal.id, `event-submit:${first.id}`), true);
    assert.equal(context.store.claimNextOrdered(goal.id, "runner-b")?.id, later.id);
    assert.equal(
      context.store.failEvent(later.id, "runner-b", "stale").state,
      "failed",
    );
    assert.equal(context.store.finishOperation(goal.id, `event-submit:${later.id}`), true);
    assert.equal(context.store.requeueEvent(later.id).state, "pending");

    assert.throws(
      () =>
        context.store.enqueueEvent({
          contextId: goal.id,
          sourceId: first.sourceId,
          sourceKind: "check",
          sourceVersion: "changed",
          sourceTime: 100,
          payload: { text: "conflict" },
        }),
      GoalContextError,
    );
  } finally {
    context.close();
  }
});

test("goal references fail closed", () => {
  assert.deepEqual(parseGoalReference("OpenAI/Repo#42"), {
    repository: "openai/repo",
    issueNumber: 42,
  });
  assert.throws(() => parseGoalReference("#42"), GoalContextError);
  assert.throws(() => parseGoalReference("owner/repo#0"), GoalContextError);
});

test("an interrupted delivery retains its original queue position for reconciliation", () => {
  const context = fixture();
  try {
    const goal = context.store.createOrGet({
      repository: "seanewest/after-party-labs",
      issueNumber: 34,
      worktreePath: context.directory,
      branch: "agent/goal-34",
    });
    const original = context.store.enqueueEvent({
      contextId: goal.id,
      sourceId: "github:merge:69",
      sourceKind: "merge",
      sourceVersion: "1",
      sourceTime: 1,
      payload: { merged: true },
    });
    assert.equal(context.store.claimNext(goal.id, "crashed-runner")?.id, original.id);
    const recovered = context.store.recoverInterruptedEvents(goal.id);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, original.id);
    assert.equal(recovered[0].state, "pending");
    assert.match(recovered[0].outcome ?? "", /reconcile client message ID/);
  } finally {
    context.close();
  }
});
