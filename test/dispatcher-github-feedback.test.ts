import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  feedbackSourceKey,
  GitHubFeedbackPoller,
  GitHubFeedbackStore,
  type GitHubFeedbackEvent,
  type GitHubFeedbackKind,
  type GitHubFeedbackPage,
  type GitHubFeedbackSource,
  type PullRequestRoute,
} from "../dispatcher/github-feedback.ts";
import {
  GhCliGitHubSource,
  isTransientGitHubError,
} from "../dispatcher/github-source.ts";
import { DispatcherQueue } from "../dispatcher/queue.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "after-party-github-feedback-"));
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

function route(overrides: Partial<PullRequestRoute> = {}): PullRequestRoute {
  return {
    repository: "example/after-party",
    pullRequestNumber: 52,
    pullRequestUrl: "https://github.com/example/after-party/pull/52",
    taskNumber: 37,
    taskUrl: "https://github.com/example/after-party/issues/37",
    taskTitle: "Route feedback",
    workType: "Task",
    status: "Review",
    implementingAgent: "beavis",
    ...overrides,
  };
}

function event(
  kind: GitHubFeedbackKind,
  id: number,
  overrides: Partial<GitHubFeedbackEvent> = {},
): GitHubFeedbackEvent {
  const defaults = route();
  const target = route({
    repository: overrides.repository ?? defaults.repository,
    pullRequestNumber:
      overrides.pullRequestNumber ?? defaults.pullRequestNumber,
  });
  const sourceKey = feedbackSourceKey(target, kind);
  return {
    sourceId: `${sourceKey}:${id}`,
    sourceKey,
    kind,
    repository: target.repository,
    pullRequestNumber: target.pullRequestNumber,
    url: `${target.pullRequestUrl}#event-${id}`,
    body: "[DARIA] Please fix the authorization boundary.",
    reviewState: kind === "review" ? "CHANGES_REQUESTED" : null,
    threadId: kind === "review_comment" ? String(id) : null,
    actorAgent: "daria",
    createdAt: new Date(1_700_000_000_000 + id).toISOString(),
    ...overrides,
  };
}

class MemorySource implements GitHubFeedbackSource {
  routes: PullRequestRoute[];
  pages = new Map<string, GitHubFeedbackPage | Error>();
  calls: string[] = [];

  constructor(routes: PullRequestRoute[] = [route()]) {
    this.routes = routes;
  }

  setPage(
    kind: GitHubFeedbackKind,
    page: number,
    value: GitHubFeedbackPage | Error,
    target = this.routes[0],
  ) {
    this.pages.set(`${feedbackSourceKey(target, kind)}:${page}`, value);
  }

  async discoverPullRequestRoutes(): Promise<PullRequestRoute[]> {
    return this.routes;
  }

  async listFeedbackPage(
    target: PullRequestRoute,
    kind: GitHubFeedbackKind,
    page: number,
    _perPage: number,
  ): Promise<GitHubFeedbackPage> {
    const key = `${feedbackSourceKey(target, kind)}:${page}`;
    this.calls.push(key);
    const result = this.pages.get(key) ?? { events: [], hasNextPage: false };
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }
}

test("source events and their checkpoint survive restart in one durable database", () => {
  const state = fixture();
  try {
    const sourceKey = feedbackSourceKey(route(), "review");
    const first = new GitHubFeedbackStore(state.databasePath, { now: state.now });
    const feedback = event("review", 100);
    const recorded = first.recordBatch(sourceKey, [feedback]);
    assert.equal(recorded.inserted, 1);
    assert.equal(recorded.checkpoint.cursorSourceId, feedback.sourceId);
    first.close();

    state.setTime(2_000);
    const reopened = new GitHubFeedbackStore(state.databasePath, { now: state.now });
    assert.equal(reopened.getEvent(feedback.sourceId)?.outcome, "pending");
    assert.equal(reopened.getCheckpoint(sourceKey).cursorSourceId, feedback.sourceId);
    assert.equal(reopened.recordBatch(sourceKey, [feedback]).inserted, 0);
    assert.equal(reopened.listPending().length, 1);
    reopened.close();
  } finally {
    state.cleanup();
  }
});

test("pagination records first and routes actionable feedback exactly once", async () => {
  const state = fixture();
  try {
    const source = new MemorySource();
    const changes = event("review", 1);
    const selfReview = event("review", 2, {
      body: "[BEAVIS] Implementation handoff.",
      actorAgent: "beavis",
      reviewState: "COMMENTED",
    });
    const approval = event("review", 3, {
      body: "[DARIA] Approved after validation.",
      reviewState: "APPROVED",
    });
    const inline = event("review_comment", 4, {
      body: "[CORNholio] This path drops the durable source ID.",
      actorAgent: "cornholio",
    });
    const notification = event("issue_comment", 5, {
      body: "[DARIA] @beavis please address the latest review thread.",
    });
    source.setPage("review", 1, {
      events: [changes, selfReview],
      hasNextPage: true,
    });
    source.setPage("review", 2, {
      events: [approval],
      hasNextPage: false,
    });
    source.setPage("review_comment", 1, {
      events: [inline],
      hasNextPage: false,
    });
    source.setPage("issue_comment", 1, {
      events: [notification],
      hasNextPage: false,
    });

    const store = new GitHubFeedbackStore(state.databasePath, { now: state.now });
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const poller = new GitHubFeedbackPoller(source, store, queue, { perPage: 2 });
    const first = await poller.poll();
    assert.deepEqual(first, {
      routes: 1,
      sources: 3,
      recorded: 5,
      queued: 3,
      ignored: 2,
      escalated: 0,
      sourceFailures: 0,
    });
    assert.equal(queue.listMessages().length, 3);
    assert.deepEqual(
      queue.listMessages().map((message) => message.recipient),
      ["beavis", "beavis", "beavis"],
    );
    assert.equal(store.getEvent(selfReview.sourceId)?.outcomeReason?.includes("self-review"), true);
    assert.equal(store.getEvent(approval.sourceId)?.outcome, "ignored");
    assert.equal(
      store.getCheckpoint(feedbackSourceKey(route(), "review")).cursorSourceId,
      approval.sourceId,
    );

    const overlapping = await poller.poll();
    assert.equal(overlapping.recorded, 0);
    assert.equal(overlapping.queued, 0);
    assert.equal(queue.listMessages().length, 3);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("a failed later page leaves that source uncheckpointed while other sources continue", async () => {
  const state = fixture();
  try {
    const source = new MemorySource();
    source.setPage("review", 1, {
      events: [event("review", 10)],
      hasNextPage: true,
    });
    source.setPage("review", 2, new Error("HTTP 503 while reading reviews"));
    const later = event("review_comment", 11);
    source.setPage("review_comment", 1, {
      events: [later],
      hasNextPage: false,
    });

    const store = new GitHubFeedbackStore(state.databasePath, { now: state.now });
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const result = await new GitHubFeedbackPoller(source, store, queue).poll();
    assert.equal(result.sourceFailures, 1);
    assert.equal(result.queued, 1);
    assert.equal(result.escalated, 1);
    assert.equal(
      store.getCheckpoint(feedbackSourceKey(route(), "review")).cursorSourceId,
      null,
    );
    assert.equal(store.getEvent(event("review", 10).sourceId), null);
    assert.equal(store.getEvent(later.sourceId)?.outcome, "queued");
    assert.equal(queue.listMessages().length, 1);
    assert.equal(queue.listEscalations({ kind: "delivery_failure" }).length, 1);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("a crash after enqueue is recovered through the queue dedupe key", async () => {
  const state = fixture();
  try {
    const feedback = event("review", 20);
    const store = new GitHubFeedbackStore(state.databasePath, { now: state.now });
    store.recordBatch(feedback.sourceKey, [feedback]);
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const precrash = queue.enqueue({
      sender: "daria",
      recipient: "beavis",
      payload: { text: "Already accepted before the poller crashed" },
      dedupeKey: `github-feedback:${feedback.sourceId}`,
    });

    const source = new MemorySource();
    source.setPage("review", 1, {
      events: [feedback],
      hasNextPage: false,
    });
    const result = await new GitHubFeedbackPoller(source, store, queue).poll();
    assert.equal(result.queued, 1);
    assert.equal(queue.listMessages().length, 1);
    assert.equal(store.getEvent(feedback.sourceId)?.outcomeId, precrash.id);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("missing ownership escalates and unavailable workers keep queued feedback", async () => {
  const state = fixture();
  try {
    const unownedRoute = route({ implementingAgent: null });
    const unavailableRoute = route({
      repository: "example/other",
      pullRequestNumber: 53,
      pullRequestUrl: "https://github.com/example/other/pull/53",
      taskNumber: 38,
      implementingAgent: "cornholio",
    });
    const source = new MemorySource([unownedRoute, unavailableRoute]);
    const ambiguous = event("review", 30);
    source.setPage("review", 1, {
      events: [ambiguous],
      hasNextPage: false,
    }, unownedRoute);
    const waiting = event("review", 31, {
      repository: unavailableRoute.repository,
      pullRequestNumber: unavailableRoute.pullRequestNumber,
      sourceKey: feedbackSourceKey(unavailableRoute, "review"),
      sourceId: `${feedbackSourceKey(unavailableRoute, "review")}:31`,
      url: `${unavailableRoute.pullRequestUrl}#review-31`,
    });
    source.setPage("review", 1, {
      events: [waiting],
      hasNextPage: false,
    }, unavailableRoute);

    const store = new GitHubFeedbackStore(state.databasePath, { now: state.now });
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    queue.setWorkerAvailability("cornholio", "unavailable", {
      reason: "configured worker is missing",
    });
    const result = await new GitHubFeedbackPoller(source, store, queue).poll();
    assert.equal(result.queued, 1);
    assert.equal(result.escalated, 2);
    assert.equal(queue.listMessages()[0].recipient, "cornholio");
    assert.equal(queue.claimNext({ consumer: "runner", leaseMs: 100 }), null);
    assert.equal(queue.listEscalations({ kind: "ambiguous_ownership" }).length, 1);
    assert.equal(queue.listEscalations({ kind: "worker_unavailable" }).length, 1);
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("feedback recorded before a Task link disappears escalates instead of being lost", async () => {
  const state = fixture();
  try {
    const feedback = event("review_comment", 35);
    const store = new GitHubFeedbackStore(state.databasePath, { now: state.now });
    store.recordBatch(feedback.sourceKey, [feedback]);
    const queue = new DispatcherQueue(state.databasePath, { now: state.now });
    const result = await new GitHubFeedbackPoller(
      new MemorySource([]),
      store,
      queue,
    ).poll();
    assert.equal(result.queued, 0);
    assert.equal(result.escalated, 1);
    assert.equal(store.getEvent(feedback.sourceId)?.outcome, "escalated");
    assert.match(
      queue.listEscalations({ kind: "ambiguous_ownership" })[0].summary,
      /No active board Task/,
    );
    queue.close();
    store.close();
  } finally {
    state.cleanup();
  }
});

test("busy and sleeping are routable while repeated change cycles escalate without reassignment", async () => {
  for (const availability of ["busy", "asleep"] as const) {
    const state = fixture();
    try {
      const source = new MemorySource();
      const reviews = [40, 41, 42].map((id) => event("review", id));
      source.setPage("review", 1, {
        events: reviews,
        hasNextPage: false,
      });
      const store = new GitHubFeedbackStore(state.databasePath, { now: state.now });
      const queue = new DispatcherQueue(state.databasePath, { now: state.now });
      queue.setWorkerAvailability("beavis", availability);
      const result = await new GitHubFeedbackPoller(source, store, queue, {
        reviewCycleThreshold: 3,
      }).poll();
      assert.equal(result.queued, 3);
      assert.equal(result.escalated, 1);
      assert.equal(queue.listMessages().length, 3);
      assert.equal(queue.listEscalations({ kind: "worker_unavailable" }).length, 0);
      assert.equal(queue.listEscalations({ kind: "repeated_review_cycles" }).length, 1);
      assert.equal(queue.getWorker("beavis").availability, availability);
      queue.close();
      store.close();
    } finally {
      state.cleanup();
    }
  }
});

test("the gh adapter retries transient failures with bounded exponential backoff", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const source = new GhCliGitHubSource({
    owner: "example",
    projectNumber: 1,
    maxAttempts: 3,
    baseDelayMs: 25,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    run: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("HTTP 429 rate limit"), {
          stderr: "temporary API rate limit",
        });
      }
      return JSON.stringify({ items: [] });
    },
  });
  assert.deepEqual(await source.discoverPullRequestRoutes(), []);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 50]);
  assert.equal(isTransientGitHubError(new Error("HTTP 503")), true);
  assert.equal(isTransientGitHubError(new Error("HTTP 404")), false);
});

test("the gh adapter parses active board routes and skips malformed source objects", async () => {
  const target = route();
  const responses = [
    JSON.stringify({
      totalCount: 2,
      items: [
        {
          status: "Review",
          agent: "Beavis",
          "work Type": "Task",
          "linked pull requests": [target.pullRequestUrl],
          content: {
            type: "Issue",
            number: 37,
            title: "Route feedback",
            url: target.taskUrl,
            repository: target.repository,
          },
        },
        {
          status: "Done",
          agent: "Daria",
          "work Type": "Task",
          "linked pull requests": ["https://github.com/example/after-party/pull/1"],
          content: {
            type: "Issue",
            number: 1,
            url: "https://github.com/example/after-party/issues/1",
            repository: target.repository,
          },
        },
      ],
    }),
    JSON.stringify([
      { id: 1, body: null },
      {
        id: 2,
        in_reply_to_id: 1,
        body: "[DARIA] Please fix this inline boundary.",
        created_at: "2026-07-19T12:00:00Z",
        html_url: `${target.pullRequestUrl}#discussion_r2`,
      },
    ]),
  ];
  const source = new GhCliGitHubSource({
    owner: "example",
    projectNumber: 1,
    run: async () => responses.shift()!,
  });
  const routes = await source.discoverPullRequestRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].implementingAgent, "beavis");
  const page = await source.listFeedbackPage(
    routes[0],
    "review_comment",
    1,
    100,
  );
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].actorAgent, "daria");
  assert.equal(page.events[0].threadId, "1");
  assert.equal(page.hasNextPage, false);
});
