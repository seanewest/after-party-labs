import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureDatabaseDirectory } from "./paths.ts";
import type { JsonValue } from "./queue.ts";

export const GOAL_CONTEXT_STATES = [
  "stopped",
  "starting",
  "running",
  "sleeping",
  "human_needed",
  "error",
] as const;

export type GoalContextState = (typeof GOAL_CONTEXT_STATES)[number];
export type GoalEventState = "pending" | "delivering" | "consumed" | "failed";

export interface GoalReference {
  repository: string;
  issueNumber: number;
}

export interface GoalContextRecord extends GoalReference {
  id: string;
  worktreePath: string;
  branch: string;
  threadId: string | null;
  threadHasActivity: boolean;
  appEndpoint: string | null;
  contextUrl: string | null;
  appServerPid: number | null;
  gatewayPid: number | null;
  generation: number;
  state: GoalContextState;
  lastHead: string | null;
  worktreeDirty: boolean;
  pendingOperation: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateGoalContextInput extends GoalReference {
  worktreePath: string;
  branch: string;
  threadId?: string | null;
}

export interface GoalRuntimeUpdate {
  threadId?: string | null;
  threadHasActivity?: boolean;
  appEndpoint?: string | null;
  contextUrl?: string | null;
  appServerPid?: number | null;
  gatewayPid?: number | null;
  state?: GoalContextState;
  lastHead?: string | null;
  worktreeDirty?: boolean;
  pendingOperation?: string | null;
  lastError?: string | null;
  incrementGeneration?: boolean;
}

export interface EnqueueGoalEventInput {
  contextId: string;
  sourceId: string;
  sourceKind: string;
  sourceVersion: string;
  sourceTime: number;
  payload: JsonValue;
}

export interface GoalEvent {
  id: string;
  contextId: string;
  sequence: number;
  sourceId: string;
  sourceKind: string;
  sourceVersion: string;
  sourceTime: number;
  payload: JsonValue;
  state: GoalEventState;
  consumer: string | null;
  attemptCount: number;
  outcome: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GoalContextStoreOptions {
  now?: () => number;
  id?: () => string;
}

type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS goal_contexts (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    thread_id TEXT,
    thread_has_activity INTEGER NOT NULL DEFAULT 0 CHECK (thread_has_activity IN (0, 1)),
    app_endpoint TEXT,
    context_url TEXT,
    app_server_pid INTEGER,
    gateway_pid INTEGER,
    generation INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN (
      'stopped', 'starting', 'running', 'sleeping', 'human_needed', 'error'
    )),
    last_head TEXT,
    worktree_dirty INTEGER NOT NULL DEFAULT 0 CHECK (worktree_dirty IN (0, 1)),
    pending_operation TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(repository, issue_number),
    UNIQUE(context_url)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS goal_events (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL REFERENCES goal_contexts(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL UNIQUE,
    source_id TEXT NOT NULL UNIQUE,
    source_kind TEXT NOT NULL,
    source_version TEXT NOT NULL,
    source_time INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'pending', 'delivering', 'consumed', 'failed'
    )),
    consumer TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS goal_events_delivery
    ON goal_events(context_id, state, source_time, source_id, sequence);

  CREATE TABLE IF NOT EXISTS goal_coordination_locks (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
`;

export class GoalContextError extends Error {}

export class GoalContextStore {
  readonly databasePath: string;

  #database: DatabaseSync;
  #now: () => number;
  #id: () => string;

  constructor(databasePath: string, options: GoalContextStoreOptions = {}) {
    ensureDatabaseDirectory(databasePath);
    this.databasePath = databasePath;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(schema);
    ensureGoalContextMigrations(this.#database);
    secureDatabaseFiles(databasePath);
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
  }

  close(): void {
    this.#database.close();
  }

  createOrGet(input: CreateGoalContextInput): GoalContextRecord {
    const repository = normalizeRepository(input.repository);
    const issueNumber = positiveInteger(input.issueNumber, "goal issue number");
    const worktreePath = absolutePath(input.worktreePath);
    const branch = nonEmpty(input.branch, "goal branch");
    const threadId = optionalNonEmpty(input.threadId);
    const now = this.#now();
    const id = this.#id();
    this.#database
      .prepare(`
        INSERT INTO goal_contexts (
          id, repository, issue_number, worktree_path, branch, thread_id,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?)
        ON CONFLICT(repository, issue_number) DO NOTHING
      `)
      .run(id, repository, issueNumber, worktreePath, branch, threadId, now, now);
    return this.requireByGoal({ repository, issueNumber });
  }

  get(id: string): GoalContextRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM goal_contexts WHERE id = ?")
      .get(nonEmpty(id, "goal context ID")) as Row | undefined;
    return row ? mapContext(row) : null;
  }

  require(id: string): GoalContextRecord {
    const context = this.get(id);
    if (!context) {
      throw new GoalContextError(`Goal context ${id} does not exist.`);
    }
    return context;
  }

  getByGoal(goal: GoalReference): GoalContextRecord | null {
    const row = this.#database
      .prepare(
        "SELECT * FROM goal_contexts WHERE repository = ? AND issue_number = ?",
      )
      .get(
        normalizeRepository(goal.repository),
        positiveInteger(goal.issueNumber, "goal issue number"),
      ) as Row | undefined;
    return row ? mapContext(row) : null;
  }

  requireByGoal(goal: GoalReference): GoalContextRecord {
    const context = this.getByGoal(goal);
    if (!context) {
      throw new GoalContextError(
        `Goal context ${normalizeRepository(goal.repository)}#${goal.issueNumber} does not exist.`,
      );
    }
    return context;
  }

  list(): GoalContextRecord[] {
    return (this.#database
      .prepare("SELECT * FROM goal_contexts ORDER BY repository, issue_number")
      .all() as Row[]).map(mapContext);
  }

  updateRuntime(id: string, update: GoalRuntimeUpdate): GoalContextRecord {
    const current = this.require(id);
    const state = update.state ?? current.state;
    if (!GOAL_CONTEXT_STATES.includes(state)) {
      throw new GoalContextError(`Invalid goal context state ${String(state)}.`);
    }
    const now = this.#now();
    this.#database
      .prepare(`
        UPDATE goal_contexts SET
          thread_id = ?, thread_has_activity = ?, app_endpoint = ?, context_url = ?,
          app_server_pid = ?, gateway_pid = ?, generation = ?, state = ?,
          last_head = ?, worktree_dirty = ?, pending_operation = ?,
          last_error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        field(update, "threadId", current.threadId),
        field(update, "threadHasActivity", current.threadHasActivity) ? 1 : 0,
        field(update, "appEndpoint", current.appEndpoint),
        field(update, "contextUrl", current.contextUrl),
        field(update, "appServerPid", current.appServerPid),
        field(update, "gatewayPid", current.gatewayPid),
        current.generation + (update.incrementGeneration ? 1 : 0),
        state,
        field(update, "lastHead", current.lastHead),
        field(update, "worktreeDirty", current.worktreeDirty) ? 1 : 0,
        field(update, "pendingOperation", current.pendingOperation),
        field(update, "lastError", current.lastError),
        now,
        current.id,
      );
    return this.require(current.id);
  }

  tryBeginRuntimeStart(id: string, expectedGeneration: number): boolean {
    const result = this.#database
      .prepare(`
        UPDATE goal_contexts SET state = 'starting', generation = generation + 1,
          last_error = NULL, updated_at = ?
        WHERE id = ? AND generation = ? AND state != 'starting'
      `)
      .run(
        this.#now(),
        nonEmpty(id, "goal context ID"),
        nonNegativeInteger(expectedGeneration, "goal generation"),
      );
    return result.changes === 1;
  }

  tryAcquireCoordinationLock(
    name: string,
    owner: string,
    ttlMs = 30_000,
  ): boolean {
    const lock = nonEmpty(name, "coordination lock name");
    const holder = nonEmpty(owner, "coordination lock owner");
    const now = this.#now();
    const expiresAt = now + positiveInteger(ttlMs, "coordination lock TTL");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("DELETE FROM goal_coordination_locks WHERE expires_at <= ?")
        .run(now);
      const result = this.#database
        .prepare(`
          INSERT INTO goal_coordination_locks(name, owner, expires_at)
          VALUES (?, ?, ?)
          ON CONFLICT(name) DO NOTHING
        `)
        .run(lock, holder, expiresAt);
      this.#database.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseCoordinationLock(name: string, owner: string): boolean {
    const result = this.#database
      .prepare("DELETE FROM goal_coordination_locks WHERE name = ? AND owner = ?")
      .run(
        nonEmpty(name, "coordination lock name"),
        nonEmpty(owner, "coordination lock owner"),
      );
    return result.changes === 1;
  }

  tryClaimOperation(id: string, operation: string): boolean {
    const context = this.require(id);
    const result = this.#database
      .prepare(`
        UPDATE goal_contexts SET pending_operation = ?, updated_at = ?
        WHERE id = ? AND pending_operation IS NULL
      `)
      .run(nonEmpty(operation, "goal operation"), this.#now(), context.id);
    return result.changes === 1;
  }

  replaceOperation(id: string, expected: string, replacement: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE goal_contexts SET pending_operation = ?, updated_at = ?
        WHERE id = ? AND pending_operation = ?
      `)
      .run(
        nonEmpty(replacement, "replacement goal operation"),
        this.#now(),
        nonEmpty(id, "goal context ID"),
        nonEmpty(expected, "expected goal operation"),
      );
    return result.changes === 1;
  }

  finishOperation(id: string, expected: string): boolean {
    const result = this.#database
      .prepare(`
        UPDATE goal_contexts SET pending_operation = NULL, updated_at = ?
        WHERE id = ? AND pending_operation = ?
      `)
      .run(
        this.#now(),
        nonEmpty(id, "goal context ID"),
        nonEmpty(expected, "expected goal operation"),
      );
    return result.changes === 1;
  }

  enqueueEvent(input: EnqueueGoalEventInput): GoalEvent {
    const context = this.require(input.contextId);
    const sourceId = nonEmpty(input.sourceId, "goal event source ID");
    const now = this.#now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare("SELECT * FROM goal_events WHERE source_id = ?")
        .get(sourceId) as Row | undefined;
      if (existing) {
        const event = mapEvent(existing);
        assertMatchingEvent(event, context.id, input);
        this.#database.exec("COMMIT");
        return event;
      }
      const sequenceRow = this.#database
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM goal_events")
        .get() as Row;
      const sequence = numberValue(sequenceRow.next_sequence, "goal event sequence");
      const id = this.#id();
      this.#database.prepare(`
          INSERT INTO goal_events (
            id, context_id, sequence, source_id, source_kind, source_version,
            source_time, payload_json, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
          id, context.id, sequence, sourceId,
          nonEmpty(input.sourceKind, "goal event source kind"),
          nonEmpty(input.sourceVersion, "goal event source version"),
          nonNegativeInteger(input.sourceTime, "goal event source time"),
          JSON.stringify(input.payload), now, now,
        );
      this.#database.exec("COMMIT");
      return this.requireEvent(id);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claimNext(contextId: string, consumer: string): GoalEvent | null {
    const context = this.require(contextId);
    const owner = nonEmpty(consumer, "goal event consumer");
    const now = this.#now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare(`
          SELECT * FROM goal_events
          WHERE context_id = ? AND state = 'pending'
          ORDER BY source_time, sequence, source_id
          LIMIT 1
        `)
        .get(context.id) as Row | undefined;
      if (!row) {
        this.#database.exec("COMMIT");
        return null;
      }
      const id = stringValue(row.id, "goal event ID");
      this.#database
        .prepare(`
          UPDATE goal_events SET state = 'delivering', consumer = ?,
            attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ? AND state = 'pending'
        `)
        .run(owner, now, id);
      this.#database.exec("COMMIT");
      return this.requireEvent(id);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextOrdered(contextId: string, consumer: string): GoalEvent | null {
    const context = this.require(contextId);
    const owner = nonEmpty(consumer, "goal event consumer");
    const now = this.#now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#database
        .prepare("SELECT pending_operation FROM goal_contexts WHERE id = ?")
        .get(context.id) as Row;
      if (current.pending_operation !== null) {
        this.#database.exec("COMMIT");
        return null;
      }
      const row = this.#database
        .prepare(`
          SELECT * FROM goal_events
          WHERE context_id = ? AND state != 'consumed'
          ORDER BY source_time, sequence, source_id
          LIMIT 1
        `)
        .get(context.id) as Row | undefined;
      if (!row || row.state !== "pending") {
        this.#database.exec("COMMIT");
        return null;
      }
      const id = stringValue(row.id, "goal event ID");
      this.#database
        .prepare(`
          UPDATE goal_events SET state = 'delivering', consumer = ?,
            attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ? AND state = 'pending'
        `)
        .run(owner, now, id);
      this.#database
        .prepare(`
          UPDATE goal_contexts SET pending_operation = ?, updated_at = ?
          WHERE id = ? AND pending_operation IS NULL
        `)
        .run(`event-submit:${id}`, now, context.id);
      this.#database.exec("COMMIT");
      return this.requireEvent(id);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  completeEvent(id: string, consumer: string, outcome: string): GoalEvent {
    return this.#finishEvent(id, consumer, "consumed", outcome);
  }

  failEvent(id: string, consumer: string, outcome: string): GoalEvent {
    return this.#finishEvent(id, consumer, "failed", outcome);
  }

  requeueEvent(id: string): GoalEvent {
    const event = this.requireEvent(id);
    if (event.state !== "failed") {
      throw new GoalContextError(`Goal event ${id} is ${event.state}, not failed.`);
    }
    this.#database
      .prepare(`
        UPDATE goal_events SET state = 'pending', consumer = NULL,
          outcome = NULL, updated_at = ? WHERE id = ?
      `)
      .run(this.#now(), event.id);
    return this.requireEvent(event.id);
  }

  requeueDeliveringForReconciliation(
    id: string,
    consumer: string,
    outcome: string,
  ): GoalEvent {
    const event = this.requireEvent(id);
    const owner = nonEmpty(consumer, "goal event consumer");
    if (event.state !== "delivering" || event.consumer !== owner) {
      throw new GoalContextError(
        `Goal event ${id} is not delivering for consumer ${owner}.`,
      );
    }
    this.#database
      .prepare(`
        UPDATE goal_events SET state = 'pending', consumer = NULL,
          outcome = ?, updated_at = ? WHERE id = ?
      `)
      .run(nonEmpty(outcome, "reconciliation outcome"), this.#now(), event.id);
    return this.requireEvent(event.id);
  }

  listEvents(contextId: string, state?: GoalEventState): GoalEvent[] {
    const context = this.require(contextId);
    const rows = state
      ? this.#database
          .prepare(`
            SELECT * FROM goal_events WHERE context_id = ? AND state = ?
            ORDER BY source_time, sequence, source_id
          `)
          .all(context.id, state)
      : this.#database
          .prepare(`
            SELECT * FROM goal_events WHERE context_id = ?
            ORDER BY source_time, sequence, source_id
          `)
          .all(context.id);
    return (rows as Row[]).map(mapEvent);
  }

  recoverInterruptedEvents(contextId: string): GoalEvent[] {
    const context = this.require(contextId);
    const interrupted = this.listEvents(context.id, "delivering");
    if (interrupted.length === 0) return [];
    if (
      context.pendingOperation &&
      !context.pendingOperation.startsWith("event-submit:") &&
      !context.pendingOperation.startsWith("turn:")
    ) {
      return [];
    }
    const recovered: GoalEvent[] = [];
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (context.pendingOperation) {
        this.#database.prepare(`
          UPDATE goal_contexts SET pending_operation = NULL, updated_at = ?
          WHERE id = ? AND pending_operation = ?
        `).run(this.#now(), context.id, context.pendingOperation);
      }
    for (const event of interrupted) {
      this.#database
        .prepare(`
          UPDATE goal_events SET state = 'pending', consumer = NULL,
            outcome = 'ambiguous runner interruption; reconcile client message ID before retry',
            updated_at = ? WHERE id = ? AND state = 'delivering'
        `)
        .run(this.#now(), event.id);
      recovered.push(this.requireEvent(event.id));
    }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return recovered;
  }

  #requireEvent(id: string): GoalEvent {
    const row = this.#database
      .prepare("SELECT * FROM goal_events WHERE id = ?")
      .get(nonEmpty(id, "goal event ID")) as Row | undefined;
    if (!row) {
      throw new GoalContextError(`Goal event ${id} does not exist.`);
    }
    return mapEvent(row);
  }

  private requireEvent(id: string): GoalEvent {
    return this.#requireEvent(id);
  }

  #finishEvent(
    id: string,
    consumer: string,
    state: "consumed" | "failed",
    outcome: string,
  ): GoalEvent {
    const event = this.requireEvent(id);
    const owner = nonEmpty(consumer, "goal event consumer");
    if (event.state !== "delivering" || event.consumer !== owner) {
      throw new GoalContextError(
        `Goal event ${id} is not delivering for consumer ${owner}.`,
      );
    }
    this.#database
      .prepare(`
        UPDATE goal_events SET state = ?, outcome = ?, updated_at = ?
        WHERE id = ? AND state = 'delivering' AND consumer = ?
      `)
      .run(state, nonEmpty(outcome, "goal event outcome"), this.#now(), id, owner);
    return this.requireEvent(id);
  }
}

export function parseGoalReference(value: string): GoalReference {
  const match = /^(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(?<issue>[1-9]\d*)$/.exec(
    value.trim(),
  );
  if (!match?.groups) {
    throw new GoalContextError(
      `Invalid goal reference "${value}". Use OWNER/REPOSITORY#NUMBER.`,
    );
  }
  return {
    repository: normalizeRepository(match.groups.repository),
    issueNumber: Number(match.groups.issue),
  };
}

function mapContext(row: Row): GoalContextRecord {
  return {
    id: stringValue(row.id, "goal context ID"),
    repository: stringValue(row.repository, "goal repository"),
    issueNumber: numberValue(row.issue_number, "goal issue number"),
    worktreePath: stringValue(row.worktree_path, "goal worktree path"),
    branch: stringValue(row.branch, "goal branch"),
    threadId: nullableString(row.thread_id),
    threadHasActivity: numberValue(row.thread_has_activity, "thread activity flag") === 1,
    appEndpoint: nullableString(row.app_endpoint),
    contextUrl: nullableString(row.context_url),
    appServerPid: nullableNumber(row.app_server_pid),
    gatewayPid: nullableNumber(row.gateway_pid),
    generation: numberValue(row.generation, "goal generation"),
    state: stringValue(row.state, "goal state") as GoalContextState,
    lastHead: nullableString(row.last_head),
    worktreeDirty: numberValue(row.worktree_dirty, "dirty flag") === 1,
    pendingOperation: nullableString(row.pending_operation),
    lastError: nullableString(row.last_error),
    createdAt: numberValue(row.created_at, "goal creation time"),
    updatedAt: numberValue(row.updated_at, "goal update time"),
  };
}

function mapEvent(row: Row): GoalEvent {
  return {
    id: stringValue(row.id, "goal event ID"),
    contextId: stringValue(row.context_id, "goal context ID"),
    sequence: numberValue(row.sequence, "goal event sequence"),
    sourceId: stringValue(row.source_id, "goal event source ID"),
    sourceKind: stringValue(row.source_kind, "goal event source kind"),
    sourceVersion: stringValue(row.source_version, "goal event source version"),
    sourceTime: numberValue(row.source_time, "goal event source time"),
    payload: JSON.parse(stringValue(row.payload_json, "goal event payload")) as JsonValue,
    state: stringValue(row.state, "goal event state") as GoalEventState,
    consumer: nullableString(row.consumer),
    attemptCount: numberValue(row.attempt_count, "goal event attempt count"),
    outcome: nullableString(row.outcome),
    createdAt: numberValue(row.created_at, "goal event creation time"),
    updatedAt: numberValue(row.updated_at, "goal event update time"),
  };
}

function field<T>(update: GoalRuntimeUpdate, key: keyof GoalRuntimeUpdate, fallback: T): T {
  return Object.prototype.hasOwnProperty.call(update, key)
    ? ((update as Record<keyof GoalRuntimeUpdate, unknown>)[key] as T)
    : fallback;
}

function normalizeRepository(value: string): string {
  const repository = nonEmpty(value, "goal repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new GoalContextError(`Invalid GitHub repository ${repository}.`);
  }
  return repository.toLowerCase();
}

function absolutePath(value: string): string {
  const path = resolve(nonEmpty(value, "goal worktree path"));
  if (!isAbsolute(path)) {
    throw new GoalContextError("Goal worktree path must be absolute.");
  }
  return path;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new GoalContextError(`${label} must not be empty.`);
  }
  return normalized;
}

function optionalNonEmpty(value: string | null | undefined): string | null {
  return value == null ? null : nonEmpty(value, "optional value");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalContextError(`${label} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GoalContextError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function stringValue(value: SqlValue | undefined, label: string): string {
  if (typeof value !== "string") {
    throw new GoalContextError(`Invalid ${label}.`);
  }
  return value;
}

function numberValue(value: SqlValue | undefined, label: string): number {
  if (typeof value !== "number") {
    throw new GoalContextError(`Invalid ${label}.`);
  }
  return value;
}

function nullableString(value: SqlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: SqlValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function ensureGoalContextMigrations(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(goal_contexts)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "thread_has_activity")) {
    database.exec(
      "ALTER TABLE goal_contexts ADD COLUMN thread_has_activity INTEGER NOT NULL DEFAULT 0 CHECK (thread_has_activity IN (0, 1))",
    );
  }
}

function assertMatchingEvent(
  event: GoalEvent,
  contextId: string,
  input: EnqueueGoalEventInput,
): void {
  if (
    event.contextId !== contextId ||
    event.sourceVersion !== input.sourceVersion ||
    JSON.stringify(event.payload) !== JSON.stringify(input.payload)
  ) {
    throw new GoalContextError(
      `Goal event source ID ${event.sourceId} conflicts with its durable record.`,
    );
  }
}

function secureDatabaseFiles(databasePath: string): void {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) return;
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}
