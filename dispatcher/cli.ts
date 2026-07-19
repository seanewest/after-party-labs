#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import { defaultDispatcherDatabasePath } from "./paths.ts";
import {
  DispatcherQueue,
  ESCALATION_KINDS,
  ESCALATION_STATUSES,
  MESSAGE_STATES,
  QueueError,
  WORKER_AVAILABILITIES,
  type Escalation,
  type EscalationKind,
  type EscalationStatus,
  type JsonValue,
  type MessageState,
  type QueueMessage,
  type WorkerAvailability,
  type WorkerRecord,
} from "./queue.ts";

interface ParsedArguments {
  options: Map<string, string | true>;
  positionals: string[];
}

export function runCli(argv = process.argv.slice(2)): number {
  const parsed = parseArguments(argv);
  const [command, ...positionals] = parsed.positionals;
  if (!command || command === "help") {
    process.stdout.write(helpText);
    return command ? 0 : 1;
  }

  const databasePath = option(parsed, "database") ?? defaultDispatcherDatabasePath();
  const json = booleanOption(parsed, "json");
  const queue = new DispatcherQueue(databasePath);

  try {
    switch (command) {
      case "enqueue": {
        const message = queue.enqueue({
          sender: requiredOption(parsed, "from"),
          recipient: requiredOption(parsed, "to"),
          payload: {
            kind: "agent_message",
            text: requiredOption(parsed, "message"),
          },
          dedupeKey: option(parsed, "dedupe-key"),
          correlationId: option(parsed, "correlation-id"),
          sourceUrl: option(parsed, "source-url"),
        });
        printMessage(message, json);
        return 0;
      }
      case "list": {
        const stateValue = option(parsed, "state");
        if (stateValue && !MESSAGE_STATES.includes(stateValue as MessageState)) {
          throw new QueueError(`Unknown message state "${stateValue}".`);
        }
        const messages = queue.listMessages({
          state: stateValue as MessageState | undefined,
          recipient: option(parsed, "recipient"),
          limit: integerOption(parsed, "limit"),
        });
        printList(messages, json);
        return 0;
      }
      case "inspect": {
        const id = requiredPositional(positionals, 0, "message ID");
        print(queue.inspect(id), json);
        return 0;
      }
      case "workers": {
        printWorkers(queue.listWorkers(), json);
        return 0;
      }
      case "worker": {
        printWorker(
          queue.getWorker(requiredPositional(positionals, 0, "worker name")),
          json,
        );
        return 0;
      }
      case "worker-state": {
        const availabilityValue = requiredPositional(
          positionals,
          1,
          "worker availability",
        );
        if (!WORKER_AVAILABILITIES.includes(availabilityValue as WorkerAvailability)) {
          throw new QueueError(`Unknown worker availability "${availabilityValue}".`);
        }
        const worker = queue.setWorkerAvailability(
          requiredPositional(positionals, 0, "worker name"),
          availabilityValue as WorkerAvailability,
          {
            reason: option(parsed, "reason"),
            observedAt: integerOption(parsed, "observed-at"),
          },
        );
        printWorker(worker, json);
        return 0;
      }
      case "escalate": {
        const kindValue = requiredOption(parsed, "kind");
        if (!ESCALATION_KINDS.includes(kindValue as EscalationKind)) {
          throw new QueueError(`Unknown escalation kind "${kindValue}".`);
        }
        const detailsValue = option(parsed, "details");
        const escalation = queue.createEscalation({
          kind: kindValue as EscalationKind,
          requestedBy: requiredOption(parsed, "requested-by"),
          summary: requiredOption(parsed, "summary"),
          subjectAgent: option(parsed, "subject-agent"),
          messageId: option(parsed, "message-id"),
          details: detailsValue ? parseJson(detailsValue, "escalation details") : undefined,
          dedupeKey: option(parsed, "dedupe-key"),
          sourceUrl: option(parsed, "source-url"),
        });
        printEscalation(escalation, json);
        return 0;
      }
      case "escalations": {
        const statusValue = option(parsed, "status");
        if (statusValue && !ESCALATION_STATUSES.includes(statusValue as EscalationStatus)) {
          throw new QueueError(`Unknown escalation status "${statusValue}".`);
        }
        const kindValue = option(parsed, "kind");
        if (kindValue && !ESCALATION_KINDS.includes(kindValue as EscalationKind)) {
          throw new QueueError(`Unknown escalation kind "${kindValue}".`);
        }
        printEscalations(
          queue.listEscalations({
            status: statusValue as EscalationStatus | undefined,
            kind: kindValue as EscalationKind | undefined,
            subjectAgent: option(parsed, "subject-agent"),
            limit: integerOption(parsed, "limit"),
          }),
          json,
        );
        return 0;
      }
      case "inspect-escalation": {
        const id = requiredPositional(positionals, 0, "escalation ID");
        const escalation = queue.getEscalation(id);
        if (!escalation) {
          throw new QueueError(`Escalation "${id}" does not exist.`);
        }
        print(escalation, json);
        return 0;
      }
      case "resolve-escalation": {
        const escalation = queue.resolveEscalation(
          requiredPositional(positionals, 0, "escalation ID"),
          requiredOption(parsed, "resolution"),
        );
        printEscalation(escalation, json);
        return 0;
      }
      case "claim": {
        const message = queue.claimNext({
          consumer: requiredOption(parsed, "consumer"),
          leaseMs: integerOption(parsed, "lease-ms") ?? 30_000,
          recipient: option(parsed, "recipient"),
        });
        if (message) {
          printMessage(message, json);
        } else if (json) {
          process.stdout.write("null\n");
        } else {
          process.stdout.write("No queued message is ready.\n");
        }
        return 0;
      }
      case "delivering": {
        const message = queue.beginDelivery(
          requiredPositional(positionals, 0, "message ID"),
          requiredOption(parsed, "consumer"),
        );
        printMessage(message, json);
        return 0;
      }
      case "receipt": {
        const detailsValue = option(parsed, "details");
        const details = detailsValue ? parseJson(detailsValue, "receipt details") : null;
        const message = queue.recordReceipt(
          requiredPositional(positionals, 0, "message ID"),
          requiredOption(parsed, "recipient"),
          details,
        );
        printMessage(message, json);
        return 0;
      }
      case "ack":
      case "acknowledge": {
        const message = queue.acknowledge(
          requiredPositional(positionals, 0, "message ID"),
        );
        printMessage(message, json);
        return 0;
      }
      case "complete": {
        const message = queue.complete(
          requiredPositional(positionals, 0, "message ID"),
        );
        printMessage(message, json);
        return 0;
      }
      case "turn-interrupted": {
        const disposition = requiredOption(parsed, "disposition");
        if (disposition !== "retry-safe" && disposition !== "escalate") {
          throw new QueueError(
            'Option --disposition must be either "retry-safe" or "escalate".',
          );
        }
        const result = queue.reportTurnInterruption({
          messageId: requiredPositional(positionals, 0, "message ID"),
          reportedBy: requiredOption(parsed, "reported-by"),
          reason: requiredOption(parsed, "error"),
          workStarted: workStartedOption(parsed),
          retrySafe: disposition === "retry-safe",
          dedupeKey: requiredOption(parsed, "dedupe-key"),
          retryAfterMs: integerOption(parsed, "retry-after-ms"),
          details: option(parsed, "details")
            ? parseJson(requiredOption(parsed, "details"), "interruption details")
            : undefined,
        });
        print(result, json);
        return 0;
      }
      case "fail": {
        const message = queue.fail(
          requiredPositional(positionals, 0, "message ID"),
          requiredOption(parsed, "consumer"),
          requiredOption(parsed, "error"),
        );
        printMessage(message, json);
        return 0;
      }
      case "retry": {
        const message = queue.retry(
          requiredPositional(positionals, 0, "message ID"),
        );
        printMessage(message, json);
        return 0;
      }
      case "cancel": {
        const message = queue.cancel(
          requiredPositional(positionals, 0, "message ID"),
        );
        printMessage(message, json);
        return 0;
      }
      case "requeue-expired": {
        const count = queue.requeueExpiredLeases();
        print({ requeued: count }, json);
        return 0;
      }
      default:
        throw new QueueError(`Unknown command "${command}". Run "party-dispatcher help".`);
    }
  } finally {
    queue.close();
  }
}

function parseArguments(argv: string[]): ParsedArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const name = argument.slice(2);
    if (!name) {
      throw new QueueError("Invalid empty option.");
    }
    if (name === "json") {
      options.set(name, true);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new QueueError(`Option --${name} requires a value.`);
    }
    options.set(name, value);
    index += 1;
  }
  return { options, positionals };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = option(parsed, name);
  if (!value) {
    throw new QueueError(`Missing required option --${name}.`);
  }
  return value;
}

function booleanOption(parsed: ParsedArguments, name: string): boolean {
  return parsed.options.get(name) === true;
}

function integerOption(parsed: ParsedArguments, name: string): number | undefined {
  const value = option(parsed, name);
  if (value === undefined) {
    return undefined;
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue)) {
    throw new QueueError(`Option --${name} must be an integer.`);
  }
  return parsedValue;
}

function workStartedOption(parsed: ParsedArguments): boolean | null {
  const value = requiredOption(parsed, "work-started").toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "unknown") {
    return null;
  }
  throw new QueueError(
    'Option --work-started must be "true", "false", or "unknown".',
  );
}

function requiredPositional(values: string[], index: number, label: string): string {
  const value = values[index];
  if (!value) {
    throw new QueueError(`Missing ${label}.`);
  }
  return value;
}

function parseJson(value: string, label: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new QueueError(`${label} must be valid JSON: ${String(error)}`);
  }
}

function printMessage(message: QueueMessage, json: boolean): void {
  if (json) {
    print(message, true);
    return;
  }
  process.stdout.write(
    `${message.state} ${message.id} ${message.sender} -> ${message.recipient} (attempts: ${message.attemptCount})\n`,
  );
}

function printList(messages: QueueMessage[], json: boolean): void {
  if (json) {
    print(messages, true);
    return;
  }
  if (messages.length === 0) {
    process.stdout.write("No queue messages.\n");
    return;
  }
  for (const message of messages) {
    printMessage(message, false);
  }
}

function printWorker(worker: WorkerRecord, json: boolean): void {
  if (json) {
    print(worker, true);
    return;
  }
  const reason = worker.reason ? ` — ${worker.reason}` : "";
  process.stdout.write(`${worker.name}: ${worker.availability}${reason}\n`);
}

function printWorkers(workers: WorkerRecord[], json: boolean): void {
  if (json) {
    print(workers, true);
    return;
  }
  for (const worker of workers) {
    printWorker(worker, false);
  }
}

function printEscalation(escalation: Escalation, json: boolean): void {
  if (json) {
    print(escalation, true);
    return;
  }
  const subject = escalation.subjectAgent ? ` for ${escalation.subjectAgent}` : "";
  process.stdout.write(
    `${escalation.status} ${escalation.id} ${escalation.kind}${subject}: ${escalation.summary}\n`,
  );
}

function printEscalations(escalations: Escalation[], json: boolean): void {
  if (json) {
    print(escalations, true);
    return;
  }
  if (escalations.length === 0) {
    process.stdout.write("No escalations.\n");
    return;
  }
  for (const escalation of escalations) {
    printEscalation(escalation, false);
  }
}

function print(value: unknown, json: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, json ? 2 : 0)}\n`);
}

const helpText = `Usage: party-dispatcher [options] <command>

Commands:
  enqueue --from NAME --to NAME --message TEXT [--dedupe-key KEY]
  list [--state STATE] [--recipient NAME] [--limit NUMBER]
  inspect MESSAGE_ID
  workers
  worker NAME
  worker-state NAME AVAILABILITY [--reason TEXT] [--observed-at EPOCH_MS]
  escalate --kind KIND --requested-by NAME --summary TEXT [options]
  escalations [--status STATUS] [--kind KIND] [--subject-agent NAME]
  inspect-escalation ESCALATION_ID
  resolve-escalation ESCALATION_ID --resolution TEXT
  claim --consumer ID [--recipient NAME] [--lease-ms NUMBER]
  delivering MESSAGE_ID --consumer ID
  receipt MESSAGE_ID --recipient NAME [--details JSON]
  acknowledge MESSAGE_ID
  complete MESSAGE_ID
  turn-interrupted MESSAGE_ID --reported-by NAME --disposition retry-safe|escalate
    --work-started true|false|unknown --error TEXT --dedupe-key KEY
    [--retry-after-ms NUMBER] [--details JSON]
  fail MESSAGE_ID --consumer ID --error TEXT
  retry MESSAGE_ID
  cancel MESSAGE_ID
  requeue-expired

Global options:
  --database PATH   Override PARTY_DISPATCHER_DB and the default state path.
  --json            Print machine-readable JSON.

Delivery is at-least-once. Stable message IDs and durable receipts make retries
recognizable; exactly-once prompt delivery is not claimed.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`party-dispatcher: ${message}\n`);
    process.exitCode = 1;
  }
}
