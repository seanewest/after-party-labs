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
