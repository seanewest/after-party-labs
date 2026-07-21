import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GitHubContinuationPoller,
  GitHubContinuationStore,
  type GitHubContinuationSource,
  type PullRequestTransitionState,
  type RegisterGitHubContinuationInput,
} from "../dispatcher/github-continuation.ts";
import { GhCliGitHubSource } from "../dispatcher/github-source.ts";
import { DispatcherQueue } from "../dispatcher/queue.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "after-party-github-continuation-"));
  const databasePath = join(directory, "dispatcher.sqlite");
  let currentTime = 1_000;
  return {
    databasePath,
    now: () => currentTime,
    setTime(value: number) {
      currentTime = value;
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function registration(
  overrides: Partial<RegisterGitHubContinuationInput> = {},
): RegisterGitHubContinuationInput {
  return {
    repository: "example/after-party",
    pullRequestNumber: 61,
    expectedHead: "abc123",
    event: "pull_request_merged",
    registeredBy: "butthead",
    recipient: "butthead",
    taskNumber: 57,
    message: "Re-read Task #57 and the merged PR, then continue from GitHub state.",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<PullRequestTransitionState> = {},
): PullRequestTransitionState {
  return {
    repository: "example/after-party",
    pullRequestNumber: 61,
    url: "https://github.com/example/after-party/pull/61",
    head: "abc123",
    open: true,
    merged: false,
    checks: [],
    ...overrides,
  };
}

class MemoryContinuationSource implements GitHubContinuationSource {
  values = new Map<string, PullRequestTransitionState | Error>();
  calls: string[] = [];

  set(value: PullRequestTransitionState | Error): void {
    if (value instanceof Error) {
      this.values.set("example/after-party#61", value);
      return;
    }
    this.values.set(
      `${value.repository.toLowerCase()}#${value.pullRequestNumber}`,
      value,
    );
  }

  async getPullRequestTransitionState(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequestTransitionState> {
    const key = `${repository.toLowerCase()}#${pullRequestNumber}`;
    this.calls.push(key);
    const value = this.values.get(key) ?? snapshot({ repository, pullRequestNumber });
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }
}

test("a one-shot registration is idempotent and survives dispatcher restart", () => {
  const state = fixture();
  try {
    const first = new GitHubContinuationStore(state.databasePath, { now: state.now });
    const registered = first.register(registration());
    assert.equal(registered.outcome, "pending");
    assert.equal(first.register(registration()).id, registered.id);
    first.close();

    state.setTime(2_000);
    const reopened = new GitHubContinuationStore(state.databasePath, { now: state.now });
    assert.deepEqual(reopened.get(registered.id), registered);
    assert.equal(reopened.list({ outcome: "pending" }).length, 1);
    assert.throws(
      () => reopened.register(registration({ message: "A conflicting instruction" })),
      /different continuation registration/,
    );
    reopened.close();
  } finally {
    state.cleanup();
  }
});

test("a merge continuation waits, then queues exactly once at the expected head", async () => {
  const state = fixture();
  try {
    const store = new GitHubContinuationStore(state.databasePath, { now: state.now });
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const source = new MemoryContinuationSource();
    const continuation = store.register(registration());
    source.set(snapshot());

    const poller = new GitHubContinuationPoller(source, store, queue);
    assert.deepEqual(await poller.poll(), {
      inspected: 1,
      pending: 1,
      queued: 0,
      failed: 0,
      escalated: 0,
      sourceFailures: 0,
    });
    source.set(snapshot({ open: false, merged: true }));
    const completed = await poller.poll();
    assert.equal(completed.queued, 1);
    assert.equal(store.get(continuation.id)?.outcome, "queued");
    assert.equal(queue.listMessages().length, 1);
    assert.deepEqual(queue.listMessages()[0].payload, {
      kind: "github_continuation",
      instruction: registration().message,
      continuationId: continuation.id,
      repository: "example/after-party",
      pullRequestNumber: 61,
      expectedHead: "abc123",
      event: "pull_request_merged",
      taskNumber: 57,
      checks: [],
    });

    const overlapping = await poller.poll();
    assert.equal(overlapping.inspected, 0);
    assert.equal(queue.listMessages().length, 1);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("a crash after enqueue is recovered by the continuation dedupe key", async () => {
  const state = fixture();
  try {
    const store = new GitHubContinuationStore(state.databasePath, { now: state.now });
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const continuation = store.register(registration());
    const precrash = queue.enqueue({
      sender: "butthead",
      recipient: "butthead",
      payload: { text: "Accepted before the poller crashed" },
      dedupeKey: `github-continuation:${continuation.id}`,
    });
    const source = new MemoryContinuationSource();
    source.set(snapshot({ open: false, merged: true }));

    const result = await new GitHubContinuationPoller(source, store, queue).poll();
    assert.equal(result.queued, 1);
    assert.equal(queue.listMessages().length, 1);
    assert.equal(store.get(continuation.id)?.outcomeId, precrash.id);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("overlapping pollers enqueue one continuation message", async () => {
  const state = fixture();
  try {
    const registeringStore = new GitHubContinuationStore(state.databasePath, {
      now: state.now,
    });
    const continuation = registeringStore.register(registration());
    registeringStore.close();

    let arrivals = 0;
    let release!: () => void;
    let bothArrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    const source: GitHubContinuationSource = {
      async getPullRequestTransitionState() {
        arrivals += 1;
        if (arrivals === 2) {
          bothArrived();
        }
        await gate;
        return snapshot({ open: false, merged: true });
      },
    };
    const firstStore = new GitHubContinuationStore(state.databasePath, {
      now: state.now,
    });
    const secondStore = new GitHubContinuationStore(state.databasePath, {
      now: state.now,
    });
    const firstQueue = new DispatcherQueue(state.databasePath, { now: state.now });
    const secondQueue = new DispatcherQueue(state.databasePath, { now: state.now });
    const first = new GitHubContinuationPoller(source, firstStore, firstQueue).poll();
    const second = new GitHubContinuationPoller(source, secondStore, secondQueue).poll();
    await ready;
    release();
    await Promise.all([first, second]);

    assert.equal(firstQueue.listMessages().length, 1);
    assert.equal(firstStore.get(continuation.id)?.outcome, "queued");
    secondQueue.close();
    firstQueue.close();
    secondStore.close();
    firstStore.close();
  } finally {
    state.cleanup();
  }
});

test("check completion is terminal regardless of success and shares one PR read", async () => {
  const state = fixture();
  try {
    const store = new GitHubContinuationStore(state.databasePath, { now: state.now });
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    store.register(
      registration({
        event: "checks_completed",
        recipient: "beavis",
        taskNumber: 58,
      }),
    );
    store.register(
      registration({
        event: "checks_completed",
        recipient: "daria",
        taskNumber: 59,
      }),
    );
    const source = new MemoryContinuationSource();
    source.set(
      snapshot({
        checks: [
          { name: "unit", completed: true, result: "SUCCESS" },
          { name: "lint", completed: false, result: null },
        ],
      }),
    );
    const poller = new GitHubContinuationPoller(source, store, queue);
    assert.equal((await poller.poll()).pending, 2);
    assert.equal(source.calls.length, 1);

    source.calls.length = 0;
    source.set(
      snapshot({
        checks: [
          { name: "unit", completed: true, result: "SUCCESS" },
          { name: "lint", completed: true, result: "FAILURE" },
        ],
      }),
    );
    const completed = await poller.poll();
    assert.equal(completed.queued, 2);
    assert.equal(source.calls.length, 1);
    assert.equal(queue.listMessages().length, 2);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("stale heads and closed-unmerged pull requests fail visibly", async () => {
  const state = fixture();
  try {
    const store = new GitHubContinuationStore(state.databasePath, { now: state.now });
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const stale = store.register(registration());
    const closed = store.register(
      registration({
        pullRequestNumber: 62,
        taskNumber: 60,
        expectedHead: "def456",
      }),
    );
    const source = new MemoryContinuationSource();
    source.set(snapshot({ head: "new-head" }));
    source.set(
      snapshot({
        pullRequestNumber: 62,
        head: "def456",
        open: false,
        merged: false,
      }),
    );

    const result = await new GitHubContinuationPoller(source, store, queue).poll();
    assert.equal(result.failed, 2);
    assert.equal(result.escalated, 2);
    assert.match(store.get(stale.id)?.outcomeReason ?? "", /Expected head/);
    assert.match(store.get(closed.id)?.outcomeReason ?? "", /closed without merging/);
    assert.equal(queue.listMessages().length, 0);
    assert.equal(queue.listEscalations({ kind: "delivery_failure" }).length, 2);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("busy and sleeping recipients stay queued while unavailable recipients escalate", async () => {
  const state = fixture();
  try {
    const store = new GitHubContinuationStore(state.databasePath, { now: state.now });
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    queue.setWorkerAvailability("beavis", "busy");
    queue.setWorkerAvailability("daria", "asleep");
    queue.setWorkerAvailability("cornholio", "unavailable", {
      reason: "worker session is not configured",
    });
    store.register(registration({ recipient: "beavis", taskNumber: 57 }));
    store.register(registration({ recipient: "daria", taskNumber: 58 }));
    store.register(registration({ recipient: "cornholio", taskNumber: 59 }));
    const source = new MemoryContinuationSource();
    source.set(snapshot({ open: false, merged: true }));

    const result = await new GitHubContinuationPoller(source, store, queue).poll();
    assert.equal(result.queued, 3);
    assert.equal(result.escalated, 1);
    assert.equal(queue.listMessages({ state: "queued" }).length, 3);
    assert.equal(queue.listEscalations({ kind: "worker_unavailable" }).length, 1);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("source failures remain pending and create one durable Morpheus escalation", async () => {
  const state = fixture();
  try {
    const store = new GitHubContinuationStore(state.databasePath, { now: state.now });
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const continuation = store.register(registration());
    const source = new MemoryContinuationSource();
    source.set(new Error("HTTP 503 from GitHub"));
    const poller = new GitHubContinuationPoller(source, store, queue);

    assert.equal((await poller.poll()).sourceFailures, 1);
    assert.equal((await poller.poll()).sourceFailures, 1);
    assert.equal(store.get(continuation.id)?.outcome, "pending");
    assert.equal(queue.listEscalations({ kind: "delivery_failure" }).length, 1);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("the gh source normalizes check runs and status contexts after transient retry", async () => {
  const calls: string[][] = [];
  const delays: number[] = [];
  let attempts = 0;
  const source = new GhCliGitHubSource({
    owner: "example",
    projectNumber: 1,
    maxAttempts: 2,
    baseDelayMs: 10,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    run: async (arguments_) => {
      calls.push(arguments_);
      attempts += 1;
      if (attempts === 1) {
        throw new Error("HTTP 503");
      }
      return JSON.stringify({
        headRefOid: "abc123",
        state: "MERGED",
        mergedAt: "2026-07-20T12:00:00Z",
        url: "https://github.com/example/after-party/pull/61",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "tests",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
          {
            __typename: "StatusContext",
            context: "deployment",
            state: "PENDING",
          },
        ],
      });
    },
  });

  const value = await source.getPullRequestTransitionState(
    "example/after-party",
    61,
  );
  assert.equal(value.merged, true);
  assert.equal(value.open, false);
  assert.deepEqual(value.checks, [
    { name: "tests", completed: true, result: "SUCCESS" },
    { name: "deployment", completed: false, result: "PENDING" },
  ]);
  assert.deepEqual(delays, [10]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [
    "pr",
    "view",
    "61",
    "--repo",
    "example/after-party",
    "--json",
    "headRefOid,state,mergedAt,statusCheckRollup,url",
  ]);
});
