import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ensureDatabaseDirectory } from "./paths.ts";
import { DispatcherQueue } from "./queue.ts";
import { parseAgentName, type AgentName } from "./registry.ts";

export const GITHUB_CONTINUATION_EVENTS = [
  "pull_request_merged",
  "checks_completed",
] as const;

export type GitHubContinuationEvent =
  (typeof GITHUB_CONTINUATION_EVENTS)[number];

export const GITHUB_CONTINUATION_OUTCOMES = [
  "pending",
  "queued",
  "failed",
] as const;

export type GitHubContinuationOutcome =
  (typeof GITHUB_CONTINUATION_OUTCOMES)[number];

export type GitHubContinuationDecision = "queue" | "fail";

export interface GitHubContinuationDecisionEvidence {
  reason: string;
  observedHead: string;
  url: string;
  checks: PullRequestCheck[];
}

export interface RegisterGitHubContinuationInput {
  repository: string;
  pullRequestNumber: number;
  expectedHead: string;
  event: GitHubContinuationEvent;
  registeredBy: AgentName | string;
  recipient: AgentName | string;
  taskNumber: number;
  message: string;
  sourceUrl?: string;
}

export interface GitHubContinuation {
  id: string;
  registrationKey: string;
  repository: string;
  pullRequestNumber: number;
  expectedHead: string;
  event: GitHubContinuationEvent;
  registeredBy: AgentName;
  recipient: AgentName;
  taskNumber: number;
  message: string;
  sourceUrl: string;
  decision: GitHubContinuationDecision | null;
  decisionEvidence: GitHubContinuationDecisionEvidence | null;
  outcome: GitHubContinuationOutcome;
  outcomeId: string | null;
  outcomeReason: string | null;
  createdAt: number;
  updatedAt: number;
  triggeredAt: number | null;
}

export interface PullRequestCheck {
  name: string;
  completed: boolean;
  result: string | null;
}

export interface PullRequestTransitionState {
  repository: string;
  pullRequestNumber: number;
  url: string;
  head: string;
  open: boolean;
  merged: boolean;
  checks: PullRequestCheck[];
}

export interface GitHubContinuationSource {
  getPullRequestTransitionState(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequestTransitionState>;
}

export interface GitHubContinuationStoreOptions {
  now?: () => number;
}

export interface ListGitHubContinuationOptions {
  outcome?: GitHubContinuationOutcome;
  limit?: number;
}

export interface GitHubContinuationPollResult {
  inspected: number;
  pending: number;
  queued: number;
  failed: number;
  escalated: number;
  sourceFailures: number;
}

type SqlValue = string | number | null;
type ContinuationRow = Record<string, SqlValue>;

const continuationSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS github_continuations (
    id TEXT PRIMARY KEY,
    registration_key TEXT NOT NULL UNIQUE,
    repository TEXT NOT NULL,
    pull_request_number INTEGER NOT NULL,
    expected_head TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN (
      'pull_request_merged', 'checks_completed'
    )),
    registered_by TEXT NOT NULL,
    recipient TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    message TEXT NOT NULL,
    source_url TEXT NOT NULL,
    terminal_decision TEXT CHECK (terminal_decision IN ('queue', 'fail')),
    decision_evidence_json TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN (
      'pending', 'queued', 'failed'
    )),
    outcome_id TEXT,
    outcome_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    triggered_at INTEGER
  ) STRICT;

  CREATE INDEX IF NOT EXISTS github_continuations_pending_order
    ON github_continuations (outcome, created_at, id);
  CREATE INDEX IF NOT EXISTS github_continuations_pull_request
    ON github_continuations (repository, pull_request_number, outcome);
`;

export class GitHubContinuationError extends Error {}

export class GitHubContinuationStore {
  readonly databasePath: string;

  #database: DatabaseSync;
  #now: () => number;

  constructor(databasePath: string, options: GitHubContinuationStoreOptions = {}) {
    ensureDatabaseDirectory(databasePath);
    this.databasePath = databasePath;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(continuationSchema);
    this.#migrateDecisionColumns();
    this.#now = options.now ?? Date.now;
  }

  close(): void {
    this.#database.close();
  }

  register(input: RegisterGitHubContinuationInput): GitHubContinuation {
    const normalized = validateRegistration(input);
    const registrationKey = continuationRegistrationKey(normalized);
    const existing = this.#getByRegistrationKey(registrationKey);
    if (existing) {
      if (!sameRegistration(existing, normalized)) {
        throw new GitHubContinuationError(
          "That GitHub transition already has a different continuation registration.",
        );
      }
      return existing;
    }

    const now = this.#now();
    const id = randomUUID();
    try {
      this.#database
        .prepare(`
          INSERT INTO github_continuations (
            id, registration_key, repository, pull_request_number,
            expected_head, event, registered_by, recipient, task_number,
            message, source_url, outcome, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `)
        .run(
          id,
          registrationKey,
          normalized.repository,
          normalized.pullRequestNumber,
          normalized.expectedHead,
          normalized.event,
          normalized.registeredBy,
          normalized.recipient,
          normalized.taskNumber,
          normalized.message,
          normalized.sourceUrl,
          now,
          now,
        );
      return this.get(id)!;
    } catch (error) {
      // An overlapping registrar may have inserted the same logical wait.
      const concurrent = this.#getByRegistrationKey(registrationKey);
      if (concurrent && sameRegistration(concurrent, normalized)) {
        return concurrent;
      }
      throw error;
    }
  }

  get(id: string): GitHubContinuation | null {
    const row = this.#database
      .prepare("SELECT * FROM github_continuations WHERE id = ?")
      .get(nonEmpty(id, "continuation ID")) as ContinuationRow | undefined;
    return row ? mapContinuation(row) : null;
  }

  list(options: ListGitHubContinuationOptions = {}): GitHubContinuation[] {
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (options.outcome) {
      if (!GITHUB_CONTINUATION_OUTCOMES.includes(options.outcome)) {
        throw new GitHubContinuationError(
          `Unknown continuation outcome "${options.outcome}".`,
        );
      }
      clauses.push("outcome = ?");
      values.push(options.outcome);
    }
    const limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new GitHubContinuationError(
        "Continuation list limit must be an integer between 1 and 10000.",
      );
    }
    values.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#database
      .prepare(`
        SELECT * FROM github_continuations
        ${where}
        ORDER BY created_at, id
        LIMIT ?
      `)
      .all(...values) as ContinuationRow[];
    return rows.map(mapContinuation);
  }

  claimDecision(
    id: string,
    decision: GitHubContinuationDecision,
    evidence: GitHubContinuationDecisionEvidence,
  ): GitHubContinuation {
    if (decision !== "queue" && decision !== "fail") {
      throw new GitHubContinuationError(
        `Invalid continuation decision "${decision}".`,
      );
    }
    const continuationId = nonEmpty(id, "continuation ID");
    const normalizedEvidence = validateDecisionEvidence(evidence);
    const now = this.#now();
    this.#database
      .prepare(`
        UPDATE github_continuations
        SET terminal_decision = ?, decision_evidence_json = ?,
            updated_at = ?, triggered_at = ?
        WHERE id = ? AND outcome = 'pending' AND terminal_decision IS NULL
      `)
      .run(
        decision,
        JSON.stringify(normalizedEvidence),
        now,
        now,
        continuationId,
      );
    const continuation = this.get(continuationId);
    if (!continuation) {
      throw new GitHubContinuationError(
        `GitHub continuation "${continuationId}" does not exist.`,
      );
    }
    return continuation;
  }

  finishDecision(
    id: string,
    outcome: Exclude<GitHubContinuationOutcome, "pending">,
    outcomeId: string | null,
    reason: string,
  ): GitHubContinuation {
    if (outcome !== "queued" && outcome !== "failed") {
      throw new GitHubContinuationError(`Invalid continuation outcome "${outcome}".`);
    }
    const continuationId = nonEmpty(id, "continuation ID");
    const now = this.#now();
    const result = this.#database
      .prepare(`
        UPDATE github_continuations
        SET outcome = ?, outcome_id = ?, outcome_reason = ?,
            updated_at = ?
        WHERE id = ? AND outcome = 'pending'
          AND terminal_decision = ?
      `)
      .run(
        outcome,
        outcomeId,
        nonEmpty(reason, "outcome reason"),
        now,
        continuationId,
        outcome === "queued" ? "queue" : "fail",
      );
    if (Number(result.changes) === 0 && !this.get(continuationId)) {
      throw new GitHubContinuationError(
        `GitHub continuation "${continuationId}" does not exist.`,
      );
    }
    return this.get(continuationId)!;
  }

  #migrateDecisionColumns(): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set(
        (
          this.#database.prepare("PRAGMA table_info(github_continuations)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      if (!columns.has("terminal_decision")) {
        this.#database.exec(
          "ALTER TABLE github_continuations ADD COLUMN terminal_decision TEXT CHECK (terminal_decision IN ('queue', 'fail'))",
        );
      }
      if (!columns.has("decision_evidence_json")) {
        this.#database.exec(
          "ALTER TABLE github_continuations ADD COLUMN decision_evidence_json TEXT",
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #getByRegistrationKey(registrationKey: string): GitHubContinuation | null {
    const row = this.#database
      .prepare("SELECT * FROM github_continuations WHERE registration_key = ?")
      .get(registrationKey) as ContinuationRow | undefined;
    return row ? mapContinuation(row) : null;
  }
}

export class GitHubContinuationPoller {
  #source: GitHubContinuationSource;
  #store: GitHubContinuationStore;
  #queue: DispatcherQueue;

  constructor(
    source: GitHubContinuationSource,
    store: GitHubContinuationStore,
    queue: DispatcherQueue,
  ) {
    this.#source = source;
    this.#store = store;
    this.#queue = queue;
  }

  async poll(): Promise<GitHubContinuationPollResult> {
    const continuations = this.#store.list({ outcome: "pending" });
    const result: GitHubContinuationPollResult = {
      inspected: continuations.length,
      pending: 0,
      queued: 0,
      failed: 0,
      escalated: 0,
      sourceFailures: 0,
    };
    const snapshots = new Map<string, PullRequestTransitionState | Error>();

    for (const listedContinuation of continuations) {
      if (listedContinuation.decision) {
        this.#recordCompletion(
          this.#completeDecision(listedContinuation),
          result,
        );
        continue;
      }

      const continuation = listedContinuation;
      const key = pullRequestKey(continuation);
      let snapshot = snapshots.get(key);
      if (!snapshot) {
        try {
          snapshot = await this.#source.getPullRequestTransitionState(
            continuation.repository,
            continuation.pullRequestNumber,
          );
        } catch (error) {
          snapshot = error instanceof Error ? error : new Error(String(error));
        }
        snapshots.set(key, snapshot);
      }

      if (snapshot instanceof Error) {
        const current = this.#store.get(continuation.id);
        if (current?.decision) {
          this.#recordCompletion(this.#completeDecision(current), result);
          continue;
        }
        result.sourceFailures += 1;
        result.pending += 1;
        this.#queue.createEscalation({
          kind: "delivery_failure",
          requestedBy: "morpheus",
          subjectAgent: continuation.recipient,
          summary: `GitHub continuation ${continuation.id} could not inspect ${continuation.repository}#${continuation.pullRequestNumber}.`,
          details: {
            continuationId: continuation.id,
            taskNumber: continuation.taskNumber,
            event: continuation.event,
            error: safeError(snapshot),
          },
          dedupeKey: `github-continuation-source:${continuation.id}`,
          sourceUrl: continuation.sourceUrl,
        });
        result.escalated += 1;
        continue;
      }

      if (snapshot.head.toLowerCase() !== continuation.expectedHead.toLowerCase()) {
        const claimed = this.#store.claimDecision(
          continuation.id,
          "fail",
          decisionEvidence(
            snapshot,
            `Expected head ${continuation.expectedHead}, but GitHub reports ${snapshot.head}.`,
          ),
        );
        this.#recordCompletion(this.#completeDecision(claimed), result);
        continue;
      }

      const transition = evaluateTransition(continuation, snapshot);
      if (transition.kind === "pending") {
        const current = this.#store.get(continuation.id);
        if (current?.decision) {
          this.#recordCompletion(this.#completeDecision(current), result);
        } else if (current?.outcome === "pending") {
          result.pending += 1;
        }
        continue;
      }
      const claimed = this.#store.claimDecision(
        continuation.id,
        transition.kind === "queued" ? "queue" : "fail",
        decisionEvidence(snapshot, transition.reason),
      );
      this.#recordCompletion(this.#completeDecision(claimed), result);
    }
    return result;
  }

  #completeDecision(continuation: GitHubContinuation): {
    outcome: "queued" | "failed";
    escalated: number;
  } | null {
    if (continuation.outcome !== "pending") {
      return null;
    }
    const evidence = continuation.decisionEvidence;
    if (!continuation.decision || !evidence) {
      throw new GitHubContinuationError(
        `Continuation "${continuation.id}" has an incomplete terminal decision.`,
      );
    }

    if (continuation.decision === "queue") {
      const message = this.#queue.enqueue({
        sender: continuation.registeredBy,
        recipient: continuation.recipient,
        payload: {
          kind: "github_continuation",
          instruction: continuation.message,
          continuationId: continuation.id,
          repository: continuation.repository,
          pullRequestNumber: continuation.pullRequestNumber,
          expectedHead: continuation.expectedHead,
          event: continuation.event,
          taskNumber: continuation.taskNumber,
          checks: evidence.checks.map((check) => ({
            name: check.name,
            completed: check.completed,
            result: check.result,
          })),
        },
        dedupeKey: `github-continuation:${continuation.id}`,
        correlationId: `github:${continuation.repository}:pull:${continuation.pullRequestNumber}`,
        sourceUrl: evidence.url,
      });
      let escalated = 0;
      const worker = this.#queue.getWorker(continuation.recipient);
      if (worker.availability === "unavailable") {
        this.#queue.createEscalation({
          kind: "worker_unavailable",
          requestedBy: continuation.registeredBy,
          subjectAgent: continuation.recipient,
          messageId: message.id,
          summary: `${continuation.recipient} is unavailable while a GitHub continuation is queued.`,
          details: {
            continuationId: continuation.id,
            repository: continuation.repository,
            pullRequestNumber: continuation.pullRequestNumber,
            taskNumber: continuation.taskNumber,
          },
          dedupeKey: `github-continuation-worker:${continuation.id}`,
          sourceUrl: evidence.url,
        });
        escalated = 1;
      }
      this.#store.finishDecision(
        continuation.id,
        "queued",
        message.id,
        evidence.reason,
      );
      return { outcome: "queued", escalated };
    }

    const escalation = this.#queue.createEscalation({
      kind: "delivery_failure",
      requestedBy: "morpheus",
      subjectAgent: continuation.recipient,
      summary: `GitHub continuation ${continuation.id} cannot complete safely.`,
      details: {
        continuationId: continuation.id,
        repository: continuation.repository,
        pullRequestNumber: continuation.pullRequestNumber,
        taskNumber: continuation.taskNumber,
        event: continuation.event,
        expectedHead: continuation.expectedHead,
        observedHead: evidence.observedHead,
        reason: evidence.reason,
      },
      dedupeKey: `github-continuation-failed:${continuation.id}`,
      sourceUrl: evidence.url,
    });
    this.#store.finishDecision(
      continuation.id,
      "failed",
      escalation.id,
      evidence.reason,
    );
    return { outcome: "failed", escalated: 1 };
  }

  #recordCompletion(
    completion: { outcome: "queued" | "failed"; escalated: number } | null,
    result: GitHubContinuationPollResult,
  ): void {
    if (!completion) {
      return;
    }
    result[completion.outcome] += 1;
    result.escalated += completion.escalated;
  }
}

function evaluateTransition(
  continuation: GitHubContinuation,
  snapshot: PullRequestTransitionState,
): { kind: "pending" | "queued" | "failed"; reason: string } {
  if (continuation.event === "pull_request_merged") {
    if (snapshot.merged) {
      return {
        kind: "queued",
        reason: `PR #${continuation.pullRequestNumber} merged at the expected head.`,
      };
    }
    if (!snapshot.open) {
      return {
        kind: "failed",
        reason: `PR #${continuation.pullRequestNumber} closed without merging.`,
      };
    }
    return { kind: "pending", reason: "The pull request is still open." };
  }

  if (snapshot.checks.length > 0 && snapshot.checks.every((check) => check.completed)) {
    return {
      kind: "queued",
      reason: `All ${snapshot.checks.length} checks completed for the expected head.`,
    };
  }
  if (!snapshot.open && !snapshot.merged) {
    return {
      kind: "failed",
      reason: `PR #${continuation.pullRequestNumber} closed before its checks completed.`,
    };
  }
  return {
    kind: "pending",
    reason:
      snapshot.checks.length === 0
        ? "GitHub has not reported any checks for the expected head."
        : "At least one check is still running.",
  };
}

function decisionEvidence(
  snapshot: PullRequestTransitionState,
  reason: string,
): GitHubContinuationDecisionEvidence {
  return {
    reason,
    observedHead: snapshot.head,
    url: snapshot.url,
    checks: snapshot.checks,
  };
}

export function continuationRegistrationKey(
  input: Pick<
    RegisterGitHubContinuationInput,
    | "repository"
    | "pullRequestNumber"
    | "expectedHead"
    | "event"
    | "recipient"
    | "taskNumber"
  >,
): string {
  return [
    "github-continuation",
    input.repository.trim().toLowerCase(),
    String(input.pullRequestNumber),
    input.expectedHead.trim().toLowerCase(),
    input.event,
    String(input.recipient).trim().toLowerCase(),
    String(input.taskNumber),
  ].join(":");
}

function validateRegistration(
  input: RegisterGitHubContinuationInput,
): Required<RegisterGitHubContinuationInput> {
  if (!GITHUB_CONTINUATION_EVENTS.includes(input.event)) {
    throw new GitHubContinuationError(
      `Unknown GitHub continuation event "${input.event}".`,
    );
  }
  const repository = nonEmpty(input.repository, "repository");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new GitHubContinuationError(
      "Repository must use the OWNER/REPOSITORY form.",
    );
  }
  const sourceUrl =
    input.sourceUrl ??
    `https://github.com/${repository}/pull/${positiveInteger(input.pullRequestNumber, "pull request number")}`;
  return {
    repository,
    pullRequestNumber: positiveInteger(
      input.pullRequestNumber,
      "pull request number",
    ),
    expectedHead: nonEmpty(input.expectedHead, "expected head"),
    event: input.event,
    registeredBy: parseAgentName(input.registeredBy),
    recipient: parseAgentName(input.recipient),
    taskNumber: positiveInteger(input.taskNumber, "Task number"),
    message: nonEmpty(input.message, "continuation message"),
    sourceUrl: nonEmpty(sourceUrl, "source URL"),
  };
}

function sameRegistration(
  existing: GitHubContinuation,
  input: Required<RegisterGitHubContinuationInput>,
): boolean {
  return (
    existing.repository === input.repository &&
    existing.pullRequestNumber === input.pullRequestNumber &&
    existing.expectedHead === input.expectedHead &&
    existing.event === input.event &&
    existing.registeredBy === input.registeredBy &&
    existing.recipient === input.recipient &&
    existing.taskNumber === input.taskNumber &&
    existing.message === input.message &&
    existing.sourceUrl === input.sourceUrl
  );
}

function mapContinuation(row: ContinuationRow): GitHubContinuation {
  const decisionValue = nullableString(row.terminal_decision);
  if (decisionValue && decisionValue !== "queue" && decisionValue !== "fail") {
    throw new GitHubContinuationError(
      `Stored continuation has invalid decision "${decisionValue}".`,
    );
  }
  const decision = decisionValue as GitHubContinuationDecision | null;
  return {
    id: String(row.id),
    registrationKey: String(row.registration_key),
    repository: String(row.repository),
    pullRequestNumber: Number(row.pull_request_number),
    expectedHead: String(row.expected_head),
    event: String(row.event) as GitHubContinuationEvent,
    registeredBy: parseAgentName(String(row.registered_by)),
    recipient: parseAgentName(String(row.recipient)),
    taskNumber: Number(row.task_number),
    message: String(row.message),
    sourceUrl: String(row.source_url),
    decision,
    decisionEvidence: parseDecisionEvidence(row.decision_evidence_json),
    outcome: String(row.outcome) as GitHubContinuationOutcome,
    outcomeId: nullableString(row.outcome_id),
    outcomeReason: nullableString(row.outcome_reason),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    triggeredAt:
      row.triggered_at === null || row.triggered_at === undefined
        ? null
        : Number(row.triggered_at),
  };
}

function validateDecisionEvidence(
  evidence: GitHubContinuationDecisionEvidence,
): GitHubContinuationDecisionEvidence {
  if (!evidence || typeof evidence !== "object") {
    throw new GitHubContinuationError("Decision evidence must be an object.");
  }
  if (!Array.isArray(evidence.checks)) {
    throw new GitHubContinuationError("Decision evidence checks must be an array.");
  }
  return {
    reason: nonEmpty(evidence.reason, "decision reason"),
    observedHead: nonEmpty(evidence.observedHead, "observed head"),
    url: nonEmpty(evidence.url, "decision source URL"),
    checks: evidence.checks.map((check) => {
      if (!check || typeof check !== "object" || typeof check.completed !== "boolean") {
        throw new GitHubContinuationError("Decision evidence contains an invalid check.");
      }
      return {
        name: nonEmpty(check.name, "check name"),
        completed: check.completed,
        result:
          check.result === null
            ? null
            : nonEmpty(check.result, "check result"),
      };
    }),
  };
}

function parseDecisionEvidence(
  value: SqlValue | undefined,
): GitHubContinuationDecisionEvidence | null {
  const serialized = nullableString(value);
  if (!serialized) {
    return null;
  }
  try {
    return validateDecisionEvidence(
      JSON.parse(serialized) as GitHubContinuationDecisionEvidence,
    );
  } catch (error) {
    if (error instanceof GitHubContinuationError) {
      throw error;
    }
    throw new GitHubContinuationError(
      `Stored continuation decision evidence is invalid JSON: ${String(error)}`,
    );
  }
}

function pullRequestKey(value: {
  repository: string;
  pullRequestNumber: number;
}): string {
  return `${value.repository.toLowerCase()}#${value.pullRequestNumber}`;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new GitHubContinuationError(`${label} must not be empty.`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitHubContinuationError(`${label} must be a positive integer.`);
  }
  return value;
}

function nullableString(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 499)}…`;
}
