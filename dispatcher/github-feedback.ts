import { DatabaseSync } from "node:sqlite";

import { ensureDatabaseDirectory } from "./paths.ts";
import { DispatcherQueue } from "./queue.ts";
import {
  isAgentName,
  parseAgentName,
  type AgentName,
} from "./registry.ts";

export const GITHUB_FEEDBACK_KINDS = [
  "review",
  "review_comment",
  "issue_comment",
] as const;

export type GitHubFeedbackKind = (typeof GITHUB_FEEDBACK_KINDS)[number];

export interface PullRequestRoute {
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  taskNumber: number;
  taskUrl: string;
  taskTitle: string;
  workType: string | null;
  status: string | null;
  implementingAgent: AgentName | null;
}

export interface GitHubFeedbackEvent {
  sourceId: string;
  sourceKey: string;
  kind: GitHubFeedbackKind;
  repository: string;
  pullRequestNumber: number;
  url: string;
  body: string;
  reviewState: string | null;
  threadId: string | null;
  actorAgent: AgentName | null;
  createdAt: string;
}

export type GitHubFeedbackOutcome =
  | "pending"
  | "queued"
  | "ignored"
  | "escalated";

export interface StoredGitHubFeedbackEvent extends GitHubFeedbackEvent {
  outcome: GitHubFeedbackOutcome;
  outcomeId: string | null;
  outcomeReason: string | null;
  recordedAt: number;
  processedAt: number | null;
}

export interface GitHubFeedbackPage {
  events: GitHubFeedbackEvent[];
  hasNextPage: boolean;
}

export interface GitHubFeedbackSource {
  discoverPullRequestRoutes(): Promise<PullRequestRoute[]>;
  listFeedbackPage(
    route: PullRequestRoute,
    kind: GitHubFeedbackKind,
    page: number,
    perPage: number,
  ): Promise<GitHubFeedbackPage>;
}

export interface GitHubFeedbackStoreOptions {
  now?: () => number;
}

export interface GitHubFeedbackCheckpoint {
  sourceKey: string;
  cursorCreatedAt: string | null;
  cursorSourceId: string | null;
  updatedAt: number;
}

export interface RecordBatchResult {
  inserted: number;
  checkpoint: GitHubFeedbackCheckpoint;
}

export interface GitHubPollResult {
  routes: number;
  sources: number;
  recorded: number;
  queued: number;
  ignored: number;
  escalated: number;
  sourceFailures: number;
}

export interface GitHubFeedbackPollerOptions {
  perPage?: number;
  maxPages?: number;
  reviewCycleThreshold?: number;
}

type SqlValue = string | number | null;
type FeedbackRow = Record<string, SqlValue>;

const feedbackSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS github_feedback_events (
    source_id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
      'review', 'review_comment', 'issue_comment'
    )),
    repository TEXT NOT NULL,
    pull_request_number INTEGER NOT NULL,
    url TEXT NOT NULL,
    body TEXT NOT NULL,
    review_state TEXT,
    thread_id TEXT,
    actor_agent TEXT,
    created_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN (
      'pending', 'queued', 'ignored', 'escalated'
    )),
    outcome_id TEXT,
    outcome_reason TEXT,
    recorded_at INTEGER NOT NULL,
    processed_at INTEGER
  ) STRICT;

  CREATE INDEX IF NOT EXISTS github_feedback_pending_order
    ON github_feedback_events (outcome, created_at, source_id);
  CREATE INDEX IF NOT EXISTS github_feedback_pull_request
    ON github_feedback_events (
      repository, pull_request_number, kind, outcome, created_at
    );

  CREATE TABLE IF NOT EXISTS github_feedback_checkpoints (
    source_key TEXT PRIMARY KEY,
    cursor_created_at TEXT,
    cursor_source_id TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT;
`;

export class GitHubFeedbackError extends Error {}

export class GitHubFeedbackStore {
  readonly databasePath: string;

  #database: DatabaseSync;
  #now: () => number;

  constructor(databasePath: string, options: GitHubFeedbackStoreOptions = {}) {
    ensureDatabaseDirectory(databasePath);
    this.databasePath = databasePath;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA busy_timeout = 5000;");
    this.#database.exec(feedbackSchema);
    this.#now = options.now ?? Date.now;
  }

  close(): void {
    this.#database.close();
  }

  recordBatch(
    sourceKey: string,
    events: GitHubFeedbackEvent[],
  ): RecordBatchResult {
    const key = nonEmpty(sourceKey, "source key");
    const now = this.#now();
    const normalized = events.map((event) => validateEvent(event, key));

    return this.#transaction(() => {
      let inserted = 0;
      for (const event of normalized) {
        const result = this.#database
          .prepare(`
            INSERT OR IGNORE INTO github_feedback_events (
              source_id, source_key, kind, repository, pull_request_number,
              url, body, review_state, thread_id, actor_agent, created_at, outcome,
              recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
          `)
          .run(
            event.sourceId,
            event.sourceKey,
            event.kind,
            event.repository,
            event.pullRequestNumber,
            event.url,
            event.body,
            event.reviewState,
            event.threadId,
            event.actorAgent,
            event.createdAt,
            now,
          );
        inserted += Number(result.changes);
      }

      const current = this.getCheckpoint(key);
      const latestEvent = normalized.reduce<GitHubFeedbackEvent | null>(
        (latest, event) =>
          !latest || compareEventCursor(event, latest) > 0 ? event : latest,
        null,
      );
      const shouldAdvance =
        latestEvent &&
        (!current.cursorCreatedAt ||
          compareCursorValues(
            latestEvent.createdAt,
            latestEvent.sourceId,
            current.cursorCreatedAt,
            current.cursorSourceId ?? "",
          ) > 0);
      const cursorCreatedAt = shouldAdvance
        ? latestEvent.createdAt
        : current.cursorCreatedAt;
      const cursorSourceId = shouldAdvance
        ? latestEvent.sourceId
        : current.cursorSourceId;

      this.#database
        .prepare(`
          INSERT INTO github_feedback_checkpoints (
            source_key, cursor_created_at, cursor_source_id, updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(source_key) DO UPDATE SET
            cursor_created_at = excluded.cursor_created_at,
            cursor_source_id = excluded.cursor_source_id,
            updated_at = excluded.updated_at
        `)
        .run(key, cursorCreatedAt, cursorSourceId, now);

      return {
        inserted,
        checkpoint: this.getCheckpoint(key),
      };
    });
  }

  getCheckpoint(sourceKey: string): GitHubFeedbackCheckpoint {
    const key = nonEmpty(sourceKey, "source key");
    const row = this.#database
      .prepare("SELECT * FROM github_feedback_checkpoints WHERE source_key = ?")
      .get(key) as FeedbackRow | undefined;
    return row
      ? mapCheckpoint(row)
      : {
          sourceKey: key,
          cursorCreatedAt: null,
          cursorSourceId: null,
          updatedAt: 0,
        };
  }

  getEvent(sourceId: string): StoredGitHubFeedbackEvent | null {
    const row = this.#database
      .prepare("SELECT * FROM github_feedback_events WHERE source_id = ?")
      .get(nonEmpty(sourceId, "source ID")) as FeedbackRow | undefined;
    return row ? mapStoredEvent(row) : null;
  }

  listPending(limit = 1000): StoredGitHubFeedbackEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new GitHubFeedbackError(
        "Pending event limit must be an integer between 1 and 10000.",
      );
    }
    const rows = this.#database
      .prepare(`
        SELECT * FROM github_feedback_events
        WHERE outcome = 'pending'
        ORDER BY created_at, source_id
        LIMIT ?
      `)
      .all(limit) as FeedbackRow[];
    return rows.map(mapStoredEvent);
  }

  markOutcome(
    sourceId: string,
    outcome: Exclude<GitHubFeedbackOutcome, "pending">,
    outcomeId: string | null,
    reason: string,
  ): StoredGitHubFeedbackEvent {
    if (!["queued", "ignored", "escalated"].includes(outcome)) {
      throw new GitHubFeedbackError(`Invalid processed outcome "${outcome}".`);
    }
    const id = nonEmpty(sourceId, "source ID");
    const explanation = nonEmpty(reason, "outcome reason");
    const now = this.#now();
    const result = this.#database
      .prepare(`
        UPDATE github_feedback_events
        SET outcome = ?, outcome_id = ?, outcome_reason = ?, processed_at = ?
        WHERE source_id = ? AND outcome = 'pending'
      `)
      .run(outcome, outcomeId, explanation, now, id);
    if (Number(result.changes) === 0) {
      const existing = this.getEvent(id);
      if (!existing) {
        throw new GitHubFeedbackError(`Feedback event "${id}" does not exist.`);
      }
      return existing;
    }
    return this.getEvent(id)!;
  }

  countQueuedReviewCycles(repository: string, pullRequestNumber: number): number {
    const row = this.#database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM github_feedback_events
        WHERE repository = ?
          AND pull_request_number = ?
          AND kind = 'review'
          AND review_state = 'CHANGES_REQUESTED'
          AND outcome = 'queued'
      `)
      .get(repository, pullRequestNumber) as FeedbackRow;
    return Number(row.count);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

export class GitHubFeedbackPoller {
  #source: GitHubFeedbackSource;
  #store: GitHubFeedbackStore;
  #queue: DispatcherQueue;
  #perPage: number;
  #maxPages: number;
  #reviewCycleThreshold: number;

  constructor(
    source: GitHubFeedbackSource,
    store: GitHubFeedbackStore,
    queue: DispatcherQueue,
    options: GitHubFeedbackPollerOptions = {},
  ) {
    this.#source = source;
    this.#store = store;
    this.#queue = queue;
    this.#perPage = positiveInteger(options.perPage ?? 100, "page size");
    this.#maxPages = positiveInteger(options.maxPages ?? 100, "maximum pages");
    this.#reviewCycleThreshold = positiveInteger(
      options.reviewCycleThreshold ?? 3,
      "review cycle threshold",
    );
  }

  async poll(): Promise<GitHubPollResult> {
    const routes = await this.#source.discoverPullRequestRoutes();
    const routeMap = groupRoutes(routes);
    const result: GitHubPollResult = {
      routes: routes.length,
      sources: 0,
      recorded: 0,
      queued: 0,
      ignored: 0,
      escalated: 0,
      sourceFailures: 0,
    };

    for (const routesForPullRequest of routeMap.values()) {
      const route = routesForPullRequest[0];
      for (const kind of GITHUB_FEEDBACK_KINDS) {
        result.sources += 1;
        const sourceKey = feedbackSourceKey(route, kind);
        try {
          const checkpoint = this.#store.getCheckpoint(sourceKey);
          const events = (await this.#readAllPages(route, kind)).filter(
            (event) =>
              !checkpoint.cursorCreatedAt ||
              compareCursorValues(
                event.createdAt,
                event.sourceId,
                checkpoint.cursorCreatedAt,
                checkpoint.cursorSourceId ?? "",
              ) > 0 ||
              !this.#store.getEvent(event.sourceId),
          );
          result.recorded += this.#store.recordBatch(sourceKey, events).inserted;
        } catch (error) {
          result.sourceFailures += 1;
          result.escalated += 1;
          const checkpoint = this.#store.getCheckpoint(sourceKey);
          this.#queue.createEscalation({
            kind: "delivery_failure",
            requestedBy: "morpheus",
            summary: `GitHub feedback source could not be read for ${route.repository}#${route.pullRequestNumber}.`,
            details: {
              sourceKey,
              checkpoint: checkpoint.cursorSourceId,
              error: safeError(error),
            },
            dedupeKey: `github-source-failure:${sourceKey}:${checkpoint.cursorSourceId ?? "initial"}`,
            sourceUrl: route.pullRequestUrl,
          });
        }
      }
    }

    for (const event of this.#store.listPending()) {
      const matchingRoutes = routeMap.get(pullRequestKey(event));
      const routed = this.#routeEvent(event, matchingRoutes ?? []);
      result[routed.outcome] += 1;
      result.escalated += routed.additionalEscalations;
    }
    return result;
  }

  async #readAllPages(
    route: PullRequestRoute,
    kind: GitHubFeedbackKind,
  ): Promise<GitHubFeedbackEvent[]> {
    const events: GitHubFeedbackEvent[] = [];
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const result = await this.#source.listFeedbackPage(
        route,
        kind,
        page,
        this.#perPage,
      );
      events.push(...result.events);
      if (!result.hasNextPage) {
        return events;
      }
    }
    throw new GitHubFeedbackError(
      `Source exceeded the configured ${this.#maxPages}-page safety limit.`,
    );
  }

  #routeEvent(
    event: StoredGitHubFeedbackEvent,
    routes: PullRequestRoute[],
  ): {
    outcome: "queued" | "ignored" | "escalated";
    additionalEscalations: number;
  } {
    if (routes.length !== 1) {
      const reason =
        routes.length === 0
          ? "No active board Task links this pull request."
          : "More than one active board Task links this pull request.";
      return {
        outcome: this.#escalateAmbiguous(event, reason, routes),
        additionalEscalations: 0,
      };
    }

    const route = routes[0];
    if (route.workType !== "Task" || !route.implementingAgent) {
      return {
        outcome: this.#escalateAmbiguous(
          event,
          "The linked board item is not an owned Task.",
          routes,
        ),
        additionalEscalations: 0,
      };
    }

    const actor = event.actorAgent;
    if (!actor) {
      if (event.kind === "review" && event.reviewState === "CHANGES_REQUESTED") {
        return {
          outcome: this.#escalateAmbiguous(
            event,
            "A changes-requested review has no signed named-agent identity.",
            routes,
          ),
          additionalEscalations: 0,
        };
      }
      this.#store.markOutcome(
        event.sourceId,
        "ignored",
        null,
        "Unsigned non-blocking feedback is not a worker notification.",
      );
      return { outcome: "ignored", additionalEscalations: 0 };
    }

    if (actor === route.implementingAgent) {
      this.#store.markOutcome(
        event.sourceId,
        "ignored",
        null,
        "Feedback authored by the implementing agent is self-review activity.",
      );
      return { outcome: "ignored", additionalEscalations: 0 };
    }

    if (!isActionable(event, route.implementingAgent)) {
      this.#store.markOutcome(
        event.sourceId,
        "ignored",
        null,
        "The event is informational and does not request implementer action.",
      );
      return { outcome: "ignored", additionalEscalations: 0 };
    }

    const instruction = conciseInstruction(event, actor);
    const message = this.#queue.enqueue({
      sender: actor,
      recipient: route.implementingAgent,
      payload: {
        kind: "github_feedback",
        instruction,
        repository: event.repository,
        pullRequestNumber: event.pullRequestNumber,
        taskNumber: route.taskNumber,
        sourceKind: event.kind,
        sourceId: event.sourceId,
        threadId: event.threadId,
      },
      dedupeKey: `github-feedback:${event.sourceId}`,
      correlationId: `github:${event.repository}:pull:${event.pullRequestNumber}`,
      sourceUrl: event.url,
    });
    this.#store.markOutcome(
      event.sourceId,
      "queued",
      message.id,
      `Routed to the Task's Original Agent, ${route.implementingAgent}.`,
    );

    const worker = this.#queue.getWorker(route.implementingAgent);
    let additionalEscalations = 0;
    if (worker.availability === "unavailable") {
      this.#queue.createEscalation({
        kind: "worker_unavailable",
        requestedBy: actor,
        subjectAgent: route.implementingAgent,
        messageId: message.id,
        summary: `${route.implementingAgent} is unavailable while PR feedback is queued.`,
        details: {
          repository: event.repository,
          pullRequestNumber: event.pullRequestNumber,
          taskNumber: route.taskNumber,
        },
        dedupeKey: `github-worker-unavailable:${event.sourceId}`,
        sourceUrl: event.url,
      });
      additionalEscalations += 1;
    }

    if (
      event.kind === "review" &&
      event.reviewState === "CHANGES_REQUESTED" &&
      this.#store.countQueuedReviewCycles(
        event.repository,
        event.pullRequestNumber,
      ) === this.#reviewCycleThreshold
    ) {
      this.#queue.createEscalation({
        kind: "repeated_review_cycles",
        requestedBy: actor,
        subjectAgent: route.implementingAgent,
        messageId: message.id,
        summary: `PR #${event.pullRequestNumber} reached the review-cycle escalation threshold.`,
        details: {
          repository: event.repository,
          pullRequestNumber: event.pullRequestNumber,
          taskNumber: route.taskNumber,
          threshold: this.#reviewCycleThreshold,
        },
        dedupeKey: `github-review-cycles:${event.repository}:${event.pullRequestNumber}`,
        sourceUrl: event.url,
      });
      additionalEscalations += 1;
    }

    return { outcome: "queued", additionalEscalations };
  }

  #escalateAmbiguous(
    event: StoredGitHubFeedbackEvent,
    reason: string,
    routes: PullRequestRoute[],
  ): "escalated" {
    const escalation = this.#queue.createEscalation({
      kind: "ambiguous_ownership",
      requestedBy: event.actorAgent ?? "morpheus",
      summary: reason,
      details: {
        sourceId: event.sourceId,
        repository: event.repository,
        pullRequestNumber: event.pullRequestNumber,
        candidateTasks: routes.map((route) => route.taskNumber),
      },
      dedupeKey: `github-routing:${event.sourceId}`,
      sourceUrl: event.url,
    });
    this.#store.markOutcome(
      event.sourceId,
      "escalated",
      escalation.id,
      reason,
    );
    return "escalated";
  }
}

export function extractSignedAgent(body: string): AgentName | null {
  const match = /^\s*\[([a-z]+)\]\s*/i.exec(body);
  if (!match) {
    return null;
  }
  const normalized = match[1].toLowerCase();
  return isAgentName(normalized) ? parseAgentName(normalized) : null;
}

export function feedbackSourceKey(
  route: PullRequestRoute,
  kind: GitHubFeedbackKind,
): string {
  return `github:${route.repository}:pull:${route.pullRequestNumber}:${kind}`;
}

function isActionable(
  event: StoredGitHubFeedbackEvent,
  implementingAgent: AgentName,
): boolean {
  if (event.kind === "review") {
    if (event.reviewState === "CHANGES_REQUESTED") {
      return true;
    }
    if (event.reviewState === "APPROVED" || event.reviewState === "DISMISSED") {
      return false;
    }
  }
  if (event.kind === "review_comment") {
    return event.body.trim().length > 0;
  }
  return (
    explicitlyMentions(event.body, implementingAgent) ||
    requestsAction(event.body)
  );
}

function explicitlyMentions(body: string, agent: AgentName): boolean {
  return new RegExp(`(?:@|\\b)${escapeRegExp(agent)}\\b`, "i").test(body);
}

function requestsAction(body: string): boolean {
  return /\b(blocker|changes? requested|please\s+(?:fix|address|change|update)|needs?\s+(?:a\s+)?(?:fix|change|update)|must\s+(?:fix|change|update)|request(?:ed)?\s+changes?)\b/i.test(
    body,
  );
}

function conciseInstruction(
  event: StoredGitHubFeedbackEvent,
  actor: AgentName,
): string {
  const withoutSignature = event.body
    .replace(/^\s*\[[a-z]+\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const detail = withoutSignature
    ? truncate(withoutSignature, 360)
    : `${event.kind.replace("_", " ")} requires attention.`;
  return `Review ${event.kind.replace("_", " ")} from ${actor} on PR #${event.pullRequestNumber}: ${detail}`;
}

function groupRoutes(
  routes: PullRequestRoute[],
): Map<string, PullRequestRoute[]> {
  const grouped = new Map<string, PullRequestRoute[]>();
  for (const route of routes) {
    const key = pullRequestKey(route);
    const values = grouped.get(key) ?? [];
    values.push(route);
    grouped.set(key, values);
  }
  return grouped;
}

function pullRequestKey(value: {
  repository: string;
  pullRequestNumber: number;
}): string {
  return `${value.repository.toLowerCase()}#${value.pullRequestNumber}`;
}

function validateEvent(
  event: GitHubFeedbackEvent,
  expectedSourceKey: string,
): GitHubFeedbackEvent {
  if (!GITHUB_FEEDBACK_KINDS.includes(event.kind)) {
    throw new GitHubFeedbackError(`Unknown feedback kind "${event.kind}".`);
  }
  if (event.sourceKey !== expectedSourceKey) {
    throw new GitHubFeedbackError(
      `Event "${event.sourceId}" belongs to a different source key.`,
    );
  }
  const timestamp = Date.parse(event.createdAt);
  if (!Number.isFinite(timestamp)) {
    throw new GitHubFeedbackError(
      `Event "${event.sourceId}" has an invalid creation time.`,
    );
  }
  return {
    ...event,
    sourceId: nonEmpty(event.sourceId, "source ID"),
    repository: nonEmpty(event.repository, "repository"),
    pullRequestNumber: positiveInteger(
      event.pullRequestNumber,
      "pull request number",
    ),
    url: nonEmpty(event.url, "feedback URL"),
    body: event.body ?? "",
    createdAt: new Date(timestamp).toISOString(),
  };
}

function compareEventCursor(
  left: GitHubFeedbackEvent,
  right: GitHubFeedbackEvent,
): number {
  return compareCursorValues(
    left.createdAt,
    left.sourceId,
    right.createdAt,
    right.sourceId,
  );
}

function compareCursorValues(
  leftCreatedAt: string,
  leftSourceId: string,
  rightCreatedAt: string,
  rightSourceId: string,
): number {
  const timestampOrder = leftCreatedAt.localeCompare(rightCreatedAt);
  return timestampOrder || leftSourceId.localeCompare(rightSourceId);
}

function mapCheckpoint(row: FeedbackRow): GitHubFeedbackCheckpoint {
  return {
    sourceKey: String(row.source_key),
    cursorCreatedAt: nullableString(row.cursor_created_at),
    cursorSourceId: nullableString(row.cursor_source_id),
    updatedAt: Number(row.updated_at),
  };
}

function mapStoredEvent(row: FeedbackRow): StoredGitHubFeedbackEvent {
  const actor = nullableString(row.actor_agent);
  return {
    sourceId: String(row.source_id),
    sourceKey: String(row.source_key),
    kind: String(row.kind) as GitHubFeedbackKind,
    repository: String(row.repository),
    pullRequestNumber: Number(row.pull_request_number),
    url: String(row.url),
    body: String(row.body),
    reviewState: nullableString(row.review_state),
    threadId: nullableString(row.thread_id),
    actorAgent: actor ? parseAgentName(actor) : null,
    createdAt: String(row.created_at),
    outcome: String(row.outcome) as GitHubFeedbackOutcome,
    outcomeId: nullableString(row.outcome_id),
    outcomeReason: nullableString(row.outcome_reason),
    recordedAt: Number(row.recorded_at),
    processedAt:
      row.processed_at === null || row.processed_at === undefined
        ? null
        : Number(row.processed_at),
  };
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new GitHubFeedbackError(`${label} must not be empty.`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitHubFeedbackError(`${label} must be a positive integer.`);
  }
  return value;
}

function nullableString(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message.replace(/\s+/g, " ").trim(), 500);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
