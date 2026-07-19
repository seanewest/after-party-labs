import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureDatabaseDirectory } from "./paths.ts";
import { AGENT_NAMES, parseAgentName, type AgentName } from "./registry.ts";

export const LIFECYCLE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
] as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export interface WorkerSessionRecord {
  name: AgentName;
  worktreePath: string;
  sessionId: string | null;
  transcriptPath: string | null;
  hookRevision: string | null;
  lastEvent: LifecycleEvent | null;
  lastEventAt: number;
  activeTurnId: string | null;
  activeMessageId: string | null;
  updatedAt: number;
}

export interface RegisterSessionInput {
  name: AgentName | string;
  cwd: string;
  sessionId: string;
  transcriptPath?: string | null;
  hookRevision: string;
  resetActiveTurn?: boolean;
  observedAt?: number;
}

export interface StartTurnInput {
  name: AgentName | string;
  sessionId: string;
  turnId: string;
  messageId?: string | null;
  observedAt?: number;
}

export interface SessionStoreOptions {
  now?: () => number;
}

type SqlValue = string | number | null;
type SessionRow = Record<string, SqlValue>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS worker_sessions (
    name TEXT PRIMARY KEY,
    worktree_path TEXT NOT NULL UNIQUE,
    session_id TEXT UNIQUE,
    transcript_path TEXT,
    hook_revision TEXT,
    last_event TEXT CHECK (
      last_event IS NULL OR last_event IN (
        'SessionStart', 'UserPromptSubmit', 'Stop'
      )
    ),
    last_event_at INTEGER NOT NULL DEFAULT 0,
    active_turn_id TEXT,
    active_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS worker_sessions_session
    ON worker_sessions (session_id);
`;

export class WorkerSessionError extends Error {}

export class WorkerSessionStore {
  readonly databasePath: string;

  #database: DatabaseSync;
  #now: () => number;

  constructor(databasePath: string, options: SessionStoreOptions = {}) {
    ensureDatabaseDirectory(databasePath);
    this.databasePath = databasePath;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(schema);
    this.#now = options.now ?? Date.now;
  }

  close(): void {
    this.#database.close();
  }

  configureWorker(name: AgentName | string, worktreePath: string): WorkerSessionRecord {
    const agent = parseAgentName(name);
    const normalizedPath = normalizeWorktree(worktreePath);
    const now = this.#now();
    this.#database
      .prepare(`
        INSERT INTO worker_sessions (
          name, worktree_path, session_id, transcript_path, hook_revision,
          last_event, last_event_at, active_turn_id, active_message_id, updated_at
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?)
        ON CONFLICT(name) DO UPDATE SET
          worktree_path = excluded.worktree_path,
          session_id = CASE
            WHEN worker_sessions.worktree_path = excluded.worktree_path
            THEN worker_sessions.session_id ELSE NULL END,
          transcript_path = CASE
            WHEN worker_sessions.worktree_path = excluded.worktree_path
            THEN worker_sessions.transcript_path ELSE NULL END,
          hook_revision = CASE
            WHEN worker_sessions.worktree_path = excluded.worktree_path
            THEN worker_sessions.hook_revision ELSE NULL END,
          last_event = CASE
            WHEN worker_sessions.worktree_path = excluded.worktree_path
            THEN worker_sessions.last_event ELSE NULL END,
          last_event_at = CASE
            WHEN worker_sessions.worktree_path = excluded.worktree_path
            THEN worker_sessions.last_event_at ELSE 0 END,
          active_turn_id = NULL,
          active_message_id = NULL,
          updated_at = excluded.updated_at
      `)
      .run(agent, normalizedPath, now);
    return this.requireWorker(agent);
  }

  getWorker(name: AgentName | string): WorkerSessionRecord | null {
    const agent = parseAgentName(name);
    const row = this.#database
      .prepare("SELECT * FROM worker_sessions WHERE name = ?")
      .get(agent) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  getWorkerByCwd(cwd: string): WorkerSessionRecord | null {
    const normalized = normalizeWorktree(cwd);
    const row = this.#database
      .prepare("SELECT * FROM worker_sessions WHERE worktree_path = ?")
      .get(normalized) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  getWorkerBySession(sessionId: string): WorkerSessionRecord | null {
    const normalized = requireUuid(sessionId, "session ID");
    const row = this.#database
      .prepare("SELECT * FROM worker_sessions WHERE session_id = ?")
      .get(normalized) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  listWorkers(): WorkerSessionRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM worker_sessions ORDER BY name")
      .all() as SessionRow[];
    return rows.map(mapSession);
  }

  registerSession(input: RegisterSessionInput): WorkerSessionRecord {
    const agent = parseAgentName(input.name);
    const configured = this.requireWorker(agent);
    const cwd = normalizeWorktree(input.cwd);
    if (configured.worktreePath !== cwd) {
      throw new WorkerSessionError(
        `Worker ${agent} is configured for ${configured.worktreePath}, not ${cwd}.`,
      );
    }
    const sessionId = requireUuid(input.sessionId, "session ID");
    const hookRevision = nonEmpty(input.hookRevision, "hook revision");
    const transcriptPath = input.transcriptPath
      ? resolve(input.transcriptPath)
      : null;
    const now = this.#now();
    const observedAt = observationTime(input.observedAt ?? now);
    const resetActiveTurn = input.resetActiveTurn ?? true;
    this.#database
      .prepare(`
        UPDATE worker_sessions
        SET session_id = ?, transcript_path = ?, hook_revision = ?,
            last_event = 'SessionStart', last_event_at = ?,
            active_turn_id = CASE WHEN ? THEN NULL ELSE active_turn_id END,
            active_message_id = CASE WHEN ? THEN NULL ELSE active_message_id END,
            updated_at = ?
        WHERE name = ? AND last_event_at <= ?
      `)
      .run(
        sessionId,
        transcriptPath,
        hookRevision,
        observedAt,
        resetActiveTurn ? 1 : 0,
        resetActiveTurn ? 1 : 0,
        now,
        agent,
        observedAt,
      );
    return this.requireWorker(agent);
  }

  startTurn(input: StartTurnInput): WorkerSessionRecord {
    const agent = parseAgentName(input.name);
    const sessionId = requireUuid(input.sessionId, "session ID");
    const turnId = nonEmpty(input.turnId, "turn ID");
    const messageId = input.messageId
      ? nonEmpty(input.messageId, "message ID")
      : null;
    const now = this.#now();
    const observedAt = observationTime(input.observedAt ?? now);
    const current = this.requireWorker(agent);
    if (current.sessionId !== sessionId) {
      throw new WorkerSessionError(
        `Session ${sessionId} is not registered to worker ${agent}.`,
      );
    }
    this.#database
      .prepare(`
        UPDATE worker_sessions
        SET last_event = 'UserPromptSubmit', last_event_at = ?,
            active_turn_id = ?, active_message_id = ?, updated_at = ?
        WHERE name = ? AND last_event_at <= ?
      `)
      .run(observedAt, turnId, messageId, now, agent, observedAt);
    return this.requireWorker(agent);
  }

  finishTurn(
    name: AgentName | string,
    sessionId: string,
    turnId: string,
    observedAt = this.#now(),
  ): { worker: WorkerSessionRecord; messageId: string | null; matched: boolean } {
    const agent = parseAgentName(name);
    const normalizedSessionId = requireUuid(sessionId, "session ID");
    const normalizedTurnId = nonEmpty(turnId, "turn ID");
    const current = this.requireWorker(agent);
    if (current.sessionId !== normalizedSessionId) {
      throw new WorkerSessionError(
        `Session ${normalizedSessionId} is not registered to worker ${agent}.`,
      );
    }
    const eventAt = observationTime(observedAt);
    const matched =
      current.activeTurnId === normalizedTurnId && eventAt >= current.lastEventAt;
    const messageId = matched ? current.activeMessageId : null;
    const now = this.#now();
    this.#database
      .prepare(`
        UPDATE worker_sessions
        SET last_event = 'Stop', last_event_at = ?,
            active_turn_id = CASE WHEN active_turn_id = ? THEN NULL ELSE active_turn_id END,
            active_message_id = CASE WHEN active_turn_id = ? THEN NULL ELSE active_message_id END,
            updated_at = ?
        WHERE name = ? AND session_id = ? AND last_event_at <= ?
      `)
      .run(
        eventAt,
        normalizedTurnId,
        normalizedTurnId,
        now,
        agent,
        normalizedSessionId,
        eventAt,
      );
    return { worker: this.requireWorker(agent), messageId, matched };
  }

  requireWorker(name: AgentName | string): WorkerSessionRecord {
    const worker = this.getWorker(name);
    if (!worker) {
      throw new WorkerSessionError(
        `Worker ${parseAgentName(name)} has no configured worktree. Run party configure first.`,
      );
    }
    return worker;
  }
}

function normalizeWorktree(value: string): string {
  const candidate = nonEmpty(value, "worktree path");
  if (!isAbsolute(candidate)) {
    throw new WorkerSessionError("Worker worktree paths must be absolute.");
  }
  const normalized = realpathSync.native(candidate);
  if (!statSync(normalized).isDirectory() || !existsSync(join(normalized, ".git"))) {
    throw new WorkerSessionError(`${normalized} is not a Git worktree.`);
  }
  return normalized;
}

function mapSession(row: SessionRow): WorkerSessionRecord {
  return {
    name: parseAgentName(String(row.name)),
    worktreePath: String(row.worktree_path),
    sessionId: nullableString(row.session_id),
    transcriptPath: nullableString(row.transcript_path),
    hookRevision: nullableString(row.hook_revision),
    lastEvent:
      row.last_event === null ? null : (String(row.last_event) as LifecycleEvent),
    lastEventAt: Number(row.last_event_at),
    activeTurnId: nullableString(row.active_turn_id),
    activeMessageId: nullableString(row.active_message_id),
    updatedAt: Number(row.updated_at),
  };
}

function requireUuid(value: string, label: string): string {
  const normalized = nonEmpty(value, label).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new WorkerSessionError(`${label} must be a UUID.`);
  }
  return normalized;
}

function observationTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerSessionError("Lifecycle observation time must be a non-negative integer.");
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new WorkerSessionError(`${label} must not be empty.`);
  }
  return normalized;
}

function nullableString(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function configuredWorkerNames(store: WorkerSessionStore): AgentName[] {
  const configured = new Set(store.listWorkers().map((worker) => worker.name));
  return AGENT_NAMES.filter((name) => configured.has(name));
}
