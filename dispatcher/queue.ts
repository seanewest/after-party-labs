import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ensureDatabaseDirectory } from "./paths.ts";
import { parseAgentName, type AgentName } from "./registry.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const MESSAGE_STATES = [
  "queued",
  "leased",
  "delivering",
  "receipted",
  "acknowledged",
  "completed",
  "failed",
  "cancelled",
] as const;

export type MessageState = (typeof MESSAGE_STATES)[number];

export interface EnqueueInput {
  id?: string;
  sender: AgentName | string;
  recipient: AgentName | string;
  payload: JsonValue;
  dedupeKey?: string;
  correlationId?: string;
  sourceUrl?: string;
  availableAt?: number;
}

export interface QueueMessage {
  id: string;
  sender: AgentName;
  recipient: AgentName;
  payload: JsonValue;
  dedupeKey: string | null;
  correlationId: string | null;
  sourceUrl: string | null;
  state: MessageState;
  createdAt: number;
  updatedAt: number;
  availableAt: number;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  cancelledAt: number | null;
  completedAt: number | null;
}

export interface DeliveryReceipt {
  messageId: string;
  recipient: AgentName;
  acceptedAt: number;
  details: JsonValue | null;
}

export type DeliveryAttemptOutcome =
  | "receipted"
  | "failed"
  | "lease_expired";

export interface DeliveryAttempt {
  id: string;
  messageId: string;
  attemptNumber: number;
  consumer: string;
  startedAt: number;
  finishedAt: number | null;
  outcome: DeliveryAttemptOutcome | null;
  error: string | null;
}

export interface QueueInspection {
  message: QueueMessage;
  receipt: DeliveryReceipt | null;
  attempts: DeliveryAttempt[];
}

export interface ClaimOptions {
  consumer: string;
  leaseMs: number;
  recipient?: AgentName | string;
}

export interface ListOptions {
  state?: MessageState;
  recipient?: AgentName | string;
  limit?: number;
}

export interface QueueOptions {
  now?: () => number;
}

type SqlValue = string | number | null;
type MessageRow = Record<string, SqlValue>;

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS dispatcher_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  INSERT OR IGNORE INTO dispatcher_meta (key, value)
  VALUES ('schema_version', '1');

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    dedupe_key TEXT UNIQUE,
    correlation_id TEXT,
    source_url TEXT,
    state TEXT NOT NULL CHECK (state IN (
      'queued', 'leased', 'delivering', 'receipted',
      'acknowledged', 'completed', 'failed', 'cancelled'
    )),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    last_error TEXT,
    cancelled_at INTEGER,
    completed_at INTEGER
  ) STRICT;

  CREATE INDEX IF NOT EXISTS messages_delivery_order
    ON messages (state, available_at, created_at, id);
  CREATE INDEX IF NOT EXISTS messages_recipient_state
    ON messages (recipient, state, available_at, created_at, id);

  CREATE TABLE IF NOT EXISTS delivery_receipts (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    details_json TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS delivery_attempts (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    consumer TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN (
      'receipted', 'failed', 'lease_expired'
    )),
    error TEXT,
    UNIQUE (message_id, attempt_number)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS delivery_attempts_message
    ON delivery_attempts (message_id, attempt_number);
`;

export class QueueError extends Error {}

export class MessageNotFoundError extends QueueError {
  constructor(id: string) {
    super(`Queue message "${id}" does not exist.`);
  }
}

export class InvalidTransitionError extends QueueError {}

export class DispatcherQueue {
  readonly databasePath: string;

  #database: DatabaseSync;
  #now: () => number;

  constructor(databasePath: string, options: QueueOptions = {}) {
    ensureDatabaseDirectory(databasePath);
    this.databasePath = databasePath;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(schema);
    this.#now = options.now ?? Date.now;
  }

  close(): void {
    this.#database.close();
  }

  enqueue(input: EnqueueInput): QueueMessage {
    const sender = parseAgentName(input.sender);
    const recipient = parseAgentName(input.recipient);
    const id = nonEmpty(input.id ?? randomUUID(), "message ID");
    const dedupeKey = optionalNonEmpty(input.dedupeKey, "dedupe key");
    const correlationId = optionalNonEmpty(input.correlationId, "correlation ID");
    const sourceUrl = optionalNonEmpty(input.sourceUrl, "source URL");
    const payloadJson = serializeJson(input.payload, "payload");
    const now = this.#now();
    const availableAt = input.availableAt ?? now;

    return this.#transaction(() => {
      if (dedupeKey) {
        const existing = this.#database
          .prepare("SELECT * FROM messages WHERE dedupe_key = ?")
          .get(dedupeKey) as MessageRow | undefined;
        if (existing) {
          return mapMessage(existing);
        }
      }

      this.#database
        .prepare(`
          INSERT INTO messages (
            id, sender, recipient, payload_json, dedupe_key, correlation_id,
            source_url, state, created_at, updated_at, available_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
        `)
        .run(
          id,
          sender,
          recipient,
          payloadJson,
          dedupeKey,
          correlationId,
          sourceUrl,
          now,
          now,
          availableAt,
        );

      return this.#requireMessage(id);
    });
  }

  getMessage(id: string): QueueMessage | null {
    const row = this.#database
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as MessageRow | undefined;
    return row ? mapMessage(row) : null;
  }

  inspect(id: string): QueueInspection {
    const message = this.getMessage(id);
    if (!message) {
      throw new MessageNotFoundError(id);
    }

    const receiptRow = this.#database
      .prepare("SELECT * FROM delivery_receipts WHERE message_id = ?")
      .get(id) as MessageRow | undefined;
    const attemptRows = this.#database
      .prepare(
        "SELECT * FROM delivery_attempts WHERE message_id = ? ORDER BY attempt_number",
      )
      .all(id) as MessageRow[];

    return {
      message,
      receipt: receiptRow ? mapReceipt(receiptRow) : null,
      attempts: attemptRows.map(mapAttempt),
    };
  }

  listMessages(options: ListOptions = {}): QueueMessage[] {
    const clauses: string[] = [];
    const values: SqlValue[] = [];

    if (options.state) {
      if (!MESSAGE_STATES.includes(options.state)) {
        throw new QueueError(`Unknown message state "${options.state}".`);
      }
      clauses.push("state = ?");
      values.push(options.state);
    }
    if (options.recipient) {
      clauses.push("recipient = ?");
      values.push(parseAgentName(options.recipient));
    }

    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new QueueError("List limit must be an integer between 1 and 1000.");
    }
    values.push(limit);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#database
      .prepare(`
        SELECT * FROM messages
        ${where}
        ORDER BY created_at, id
        LIMIT ?
      `)
      .all(...values) as MessageRow[];
    return rows.map(mapMessage);
  }

  claimNext(options: ClaimOptions): QueueMessage | null {
    const consumer = nonEmpty(options.consumer, "consumer");
    const leaseMs = positiveInteger(options.leaseMs, "lease duration");
    const recipient = options.recipient
      ? parseAgentName(options.recipient)
      : null;
    const now = this.#now();

    return this.#transaction(() => {
      this.#requeueExpiredLeases(now);
      const row = this.#database
        .prepare(`
          SELECT * FROM messages
          WHERE state = 'queued'
            AND available_at <= ?
            AND (? IS NULL OR recipient = ?)
          ORDER BY available_at, created_at, id
          LIMIT 1
        `)
        .get(now, recipient, recipient) as MessageRow | undefined;
      if (!row) {
        return null;
      }

      const messageId = String(row.id);
      const attemptNumber = Number(row.attempt_count) + 1;
      const leaseExpiresAt = now + leaseMs;
      this.#database
        .prepare(`
          UPDATE messages
          SET state = 'leased', updated_at = ?, attempt_count = ?,
              lease_owner = ?, lease_expires_at = ?, last_error = NULL
          WHERE id = ? AND state = 'queued'
        `)
        .run(now, attemptNumber, consumer, leaseExpiresAt, messageId);
      this.#database
        .prepare(`
          INSERT INTO delivery_attempts (
            id, message_id, attempt_number, consumer, started_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(randomUUID(), messageId, attemptNumber, consumer, now);

      return this.#requireMessage(messageId);
    });
  }

  renewLease(id: string, consumer: string, leaseMs: number): QueueMessage {
    const owner = nonEmpty(consumer, "consumer");
    const duration = positiveInteger(leaseMs, "lease duration");
    const now = this.#now();
    return this.#transaction(() => {
      const message = this.#requireMessage(id);
      this.#requireOwnedInFlight(message, owner, now);
      this.#database
        .prepare(
          "UPDATE messages SET updated_at = ?, lease_expires_at = ? WHERE id = ?",
        )
        .run(now, now + duration, id);
      return this.#requireMessage(id);
    });
  }

  beginDelivery(id: string, consumer: string): QueueMessage {
    const owner = nonEmpty(consumer, "consumer");
    const now = this.#now();
    return this.#transaction(() => {
      const message = this.#requireMessage(id);
      this.#requireOwnedInFlight(message, owner, now, ["leased"]);
      this.#database
        .prepare("UPDATE messages SET state = 'delivering', updated_at = ? WHERE id = ?")
        .run(now, id);
      return this.#requireMessage(id);
    });
  }

  recordReceipt(
    id: string,
    recipient: AgentName | string,
    details: JsonValue | null = null,
  ): QueueMessage {
    const acceptedBy = parseAgentName(recipient);
    const detailsJson = details === null ? null : serializeJson(details, "receipt details");
    const now = this.#now();
    return this.#transaction(() => {
      const message = this.#requireMessage(id);
      if (message.recipient !== acceptedBy) {
        throw new QueueError(
          `Message "${id}" is addressed to ${message.recipient}, not ${acceptedBy}.`,
        );
      }

      this.#database
        .prepare(`
          INSERT OR IGNORE INTO delivery_receipts (
            message_id, recipient, accepted_at, details_json
          ) VALUES (?, ?, ?, ?)
        `)
        .run(id, acceptedBy, now, detailsJson);

      if (!["acknowledged", "completed"].includes(message.state)) {
        this.#database
          .prepare(`
            UPDATE messages
            SET state = 'receipted', updated_at = ?, lease_owner = NULL,
                lease_expires_at = NULL, last_error = NULL, cancelled_at = NULL
            WHERE id = ?
          `)
          .run(now, id);
      }
      this.#finishOpenAttempt(id, now, "receipted", null);
      return this.#requireMessage(id);
    });
  }

  acknowledge(id: string): QueueMessage {
    const now = this.#now();
    return this.#transaction(() => {
      const message = this.#requireMessage(id);
      if (message.state === "acknowledged" || message.state === "completed") {
        return message;
      }
      this.#requireState(message, ["receipted"], "acknowledge");
      this.#database
        .prepare("UPDATE messages SET state = 'acknowledged', updated_at = ? WHERE id = ?")
        .run(now, id);
      return this.#requireMessage(id);
    });
  }

  complete(id: string): QueueMessage {
    const now = this.#now();
    return this.#transaction(() => {
      const message = this.#requireMessage(id);
      if (message.state === "completed") {
        return message;
      }
      this.#requireState(message, ["acknowledged"], "complete");
      this.#database
        .prepare(`
          UPDATE messages
          SET state = 'completed', updated_at = ?, completed_at = ?
          WHERE id = ?
        `)
        .run(now, now, id);
      return this.#requireMessage(id);
    });
  }

  fail(id: string, consumer: string, error: string): QueueMessage {
    const owner = nonEmpty(consumer, "consumer");
    const reason = nonEmpty(error, "failure reason");
    const now = this.#now();
    return this.#transaction(() => {
      const message = this.#requireMessage(id);
      this.#requireOwnedInFlight(message, owner, now);
      this.#database
        .prepare(`
          UPDATE messages
          SET state = 'failed', updated_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error = ?
          WHERE id = ?
        `)
        .run(now, reason, id);
      this.#finishOpenAttempt(id, now, "failed", reason);
      return this.#requireMessage(id);
    });
  }

  retry(id: string, availableAt = this.#now()): QueueMessage {
    const now = this.#now();
    return this.#transaction(() => {
      const message = this.#requireMessage(id);
      this.#requireState(message, ["failed"], "retry");
      this.#database
        .prepare(`
          UPDATE messages
          SET state = 'queued', updated_at = ?, available_at = ?,
              last_error = NULL, lease_owner = NULL, lease_expires_at = NULL
          WHERE id = ?
        `)
        .run(now, availableAt, id);
      return this.#requireMessage(id);
    });
  }

  cancel(id: string): QueueMessage {
    const now = this.#now();
    return this.#transaction(() => {
      const message = this.#requireMessage(id);
      if (message.state === "cancelled") {
        return message;
      }
      this.#requireState(message, ["queued", "failed"], "cancel");
      this.#database
        .prepare(`
          UPDATE messages
          SET state = 'cancelled', updated_at = ?, cancelled_at = ?
          WHERE id = ?
        `)
        .run(now, now, id);
      return this.#requireMessage(id);
    });
  }

  requeueExpiredLeases(): number {
    return this.#transaction(() => this.#requeueExpiredLeases(this.#now()));
  }

  #requeueExpiredLeases(now: number): number {
    this.#database
      .prepare(`
        UPDATE delivery_attempts
        SET finished_at = ?, outcome = 'lease_expired', error = 'Lease expired'
        WHERE finished_at IS NULL
          AND message_id IN (
            SELECT id FROM messages
            WHERE state IN ('leased', 'delivering')
              AND lease_expires_at <= ?
          )
      `)
      .run(now, now);
    const result = this.#database
      .prepare(`
        UPDATE messages
        SET state = 'queued', updated_at = ?, available_at = ?,
            lease_owner = NULL, lease_expires_at = NULL,
            last_error = 'Previous delivery lease expired'
        WHERE state IN ('leased', 'delivering')
          AND lease_expires_at <= ?
      `)
      .run(now, now, now);
    return Number(result.changes);
  }

  #requireMessage(id: string): QueueMessage {
    const message = this.getMessage(id);
    if (!message) {
      throw new MessageNotFoundError(id);
    }
    return message;
  }

  #requireOwnedInFlight(
    message: QueueMessage,
    consumer: string,
    now: number,
    states: MessageState[] = ["leased", "delivering"],
  ): void {
    this.#requireState(message, states, "operate on");
    if (message.leaseOwner !== consumer) {
      throw new InvalidTransitionError(
        `Message "${message.id}" is leased to ${message.leaseOwner ?? "nobody"}, not ${consumer}.`,
      );
    }
    if (message.leaseExpiresAt === null || message.leaseExpiresAt <= now) {
      throw new InvalidTransitionError(`Message "${message.id}" has an expired lease.`);
    }
  }

  #requireState(
    message: QueueMessage,
    allowed: MessageState[],
    action: string,
  ): void {
    if (!allowed.includes(message.state)) {
      throw new InvalidTransitionError(
        `Cannot ${action} message "${message.id}" while it is ${message.state}; expected ${allowed.join(" or ")}.`,
      );
    }
  }

  #finishOpenAttempt(
    messageId: string,
    finishedAt: number,
    outcome: DeliveryAttemptOutcome,
    error: string | null,
  ): void {
    this.#database
      .prepare(`
        UPDATE delivery_attempts
        SET finished_at = ?, outcome = ?, error = ?
        WHERE message_id = ? AND finished_at IS NULL
      `)
      .run(finishedAt, outcome, error, messageId);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapMessage(row: MessageRow): QueueMessage {
  return {
    id: String(row.id),
    sender: parseAgentName(String(row.sender)),
    recipient: parseAgentName(String(row.recipient)),
    payload: parseJson(String(row.payload_json), "stored message payload"),
    dedupeKey: nullableString(row.dedupe_key),
    correlationId: nullableString(row.correlation_id),
    sourceUrl: nullableString(row.source_url),
    state: String(row.state) as MessageState,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    availableAt: Number(row.available_at),
    attemptCount: Number(row.attempt_count),
    leaseOwner: nullableString(row.lease_owner),
    leaseExpiresAt: nullableNumber(row.lease_expires_at),
    lastError: nullableString(row.last_error),
    cancelledAt: nullableNumber(row.cancelled_at),
    completedAt: nullableNumber(row.completed_at),
  };
}

function mapReceipt(row: MessageRow): DeliveryReceipt {
  return {
    messageId: String(row.message_id),
    recipient: parseAgentName(String(row.recipient)),
    acceptedAt: Number(row.accepted_at),
    details:
      row.details_json === null
        ? null
        : parseJson(String(row.details_json), "stored receipt details"),
  };
}

function mapAttempt(row: MessageRow): DeliveryAttempt {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    attemptNumber: Number(row.attempt_number),
    consumer: String(row.consumer),
    startedAt: Number(row.started_at),
    finishedAt: nullableNumber(row.finished_at),
    outcome: row.outcome === null ? null : (String(row.outcome) as DeliveryAttemptOutcome),
    error: nullableString(row.error),
  };
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new QueueError(`${label} must not be empty.`);
  }
  return normalized;
}

function optionalNonEmpty(value: string | undefined, label: string): string | null {
  return value === undefined ? null : nonEmpty(value, label);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new QueueError(`${label} must be a positive integer.`);
  }
  return value;
}

function serializeJson(value: JsonValue, label: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("value is not JSON serializable");
    }
    return serialized;
  } catch (error) {
    throw new QueueError(`${label} must be valid JSON: ${String(error)}`);
  }
}

function parseJson(value: string, label: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new QueueError(`${label} is invalid JSON: ${String(error)}`);
  }
}

function nullableString(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: SqlValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}
