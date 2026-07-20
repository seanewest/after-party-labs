import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dispatcher/cli.ts");

async function runCli(databasePath: string, ...arguments_: string[]) {
  return execFileAsync(process.execPath, [cliPath, "--database", databasePath, ...arguments_], {
    cwd: resolve("."),
  });
}

test("the CLI enqueues, lists, and inspects an understandable durable message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-cli-"));
  const databasePath = join(directory, "queue.sqlite");
  try {
    const enqueue = await runCli(
      databasePath,
      "enqueue",
      "--from",
      "morpheus",
      "--to",
      "beavis",
      "--message",
      "Check the board",
      "--dedupe-key",
      "test:cli:1",
      "--json",
    );
    const message = JSON.parse(enqueue.stdout) as { id: string; state: string };
    assert.equal(message.state, "queued");

    const list = await runCli(databasePath, "list");
    assert.match(list.stdout, new RegExp(`queued ${message.id} morpheus -> beavis`));

    const inspect = await runCli(databasePath, "inspect", message.id, "--json");
    const inspection = JSON.parse(inspect.stdout) as {
      message: { payload: { text: string } };
    };
    assert.equal(inspection.message.payload.text, "Check the board");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two CLI consumers racing for one message never both receive it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-cli-race-"));
  const databasePath = join(directory, "queue.sqlite");
  try {
    await runCli(
      databasePath,
      "enqueue",
      "--from",
      "daria",
      "--to",
      "cornholio",
      "--message",
      "Only once concurrently",
    );

    const results = await Promise.all([
      runCli(databasePath, "claim", "--consumer", "runner-a", "--json"),
      runCli(databasePath, "claim", "--consumer", "runner-b", "--json"),
    ]);
    const values = results.map((result) => JSON.parse(result.stdout) as object | null);
    assert.equal(values.filter((value) => value !== null).length, 1);
    assert.equal(values.filter((value) => value === null).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the CLI reports worker unavailability and durable escalation state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-cli-escalation-"));
  const databasePath = join(directory, "queue.sqlite");
  try {
    const workers = await runCli(databasePath, "workers");
    assert.match(workers.stdout, /beavis: unknown/);
    assert.match(workers.stdout, /morpheus: unknown/);

    const unavailable = await runCli(
      databasePath,
      "worker-state",
      "beavis",
      "unavailable",
      "--reason",
      "configured worktree is missing",
    );
    assert.match(
      unavailable.stdout,
      /beavis: unavailable — configured worktree is missing/,
    );

    const created = await runCli(
      databasePath,
      "escalate",
      "--kind",
      "worker_unavailable",
      "--requested-by",
      "morpheus",
      "--subject-agent",
      "beavis",
      "--summary",
      "Beavis cannot be resumed",
      "--dedupe-key",
      "cli:worker-unavailable:beavis",
      "--json",
    );
    const escalation = JSON.parse(created.stdout) as { id: string; status: string };
    assert.equal(escalation.status, "open");

    const listed = await runCli(databasePath, "escalations", "--status", "open");
    assert.match(listed.stdout, new RegExp(`open ${escalation.id} worker_unavailable for beavis`));

    const resolved = await runCli(
      databasePath,
      "resolve-escalation",
      escalation.id,
      "--resolution",
      "The worktree was restored",
      "--json",
    );
    assert.equal((JSON.parse(resolved.stdout) as { status: string }).status, "resolved");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the CLI reports a safe post-receipt interruption for delayed retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-cli-interruption-"));
  const databasePath = join(directory, "queue.sqlite");
  try {
    const created = await runCli(
      databasePath,
      "enqueue",
      "--from",
      "morpheus",
      "--to",
      "cornholio",
      "--message",
      "Resume Task #36",
      "--json",
    );
    const message = JSON.parse(created.stdout) as { id: string };
    await runCli(databasePath, "claim", "--consumer", "runner-a");
    await runCli(databasePath, "delivering", message.id, "--consumer", "runner-a");
    await runCli(databasePath, "receipt", message.id, "--recipient", "cornholio");
    await runCli(databasePath, "ack", message.id);

    const result = await runCli(
      databasePath,
      "turn-interrupted",
      message.id,
      "--reported-by",
      "cornholio",
      "--disposition",
      "retry-safe",
      "--work-started",
      "false",
      "--error",
      "Selected model is at capacity",
      "--dedupe-key",
      "turn:cli:capacity",
      "--retry-after-ms",
      "30000",
      "--details",
      '{"event":"turn.failed"}',
      "--json",
    );
    const interruption = JSON.parse(result.stdout) as {
      message: { id: string; state: string };
      interruption: { disposition: string; retryAvailableAt: number };
    };
    assert.equal(interruption.message.id, message.id);
    assert.equal(interruption.message.state, "queued");
    assert.equal(interruption.interruption.disposition, "retry_safe");
    assert.ok(interruption.interruption.retryAvailableAt > Date.now());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the CLI rejects invalid worker identities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-cli-invalid-"));
  const databasePath = join(directory, "queue.sqlite");
  try {
    await assert.rejects(
      runCli(
        databasePath,
        "enqueue",
        "--from",
        "morpheus",
        "--to",
        "not-a-worker",
        "--message",
        "No destination",
      ),
      (error: unknown) => {
        assert.match(String(error), /Unknown agent/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the CLI registers and inspects one durable GitHub continuation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-cli-continuation-"));
  const databasePath = join(directory, "queue.sqlite");
  try {
    const arguments_ = [
      "continuation-register",
      "--repository",
      "example/after-party",
      "--pull-request",
      "61",
      "--expected-head",
      "abc123",
      "--event",
      "checks_completed",
      "--from",
      "butthead",
      "--to",
      "daria",
      "--task",
      "57",
      "--message",
      "Review the completed checks and continue Task #57.",
      "--json",
    ];
    const created = await runCli(databasePath, ...arguments_);
    const continuation = JSON.parse(created.stdout) as {
      id: string;
      outcome: string;
    };
    assert.equal(continuation.outcome, "pending");

    const duplicate = await runCli(databasePath, ...arguments_);
    assert.equal(
      (JSON.parse(duplicate.stdout) as { id: string }).id,
      continuation.id,
    );

    const listed = await runCli(
      databasePath,
      "continuations",
      "--outcome",
      "pending",
    );
    assert.match(listed.stdout, new RegExp(`pending ${continuation.id}`));
    assert.match(listed.stdout, /checks_completed -> daria \(Task #57\)/);

    const inspected = await runCli(
      databasePath,
      "inspect-continuation",
      continuation.id,
      "--json",
    );
    assert.equal(
      (JSON.parse(inspected.stdout) as { expectedHead: string }).expectedHead,
      "abc123",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
