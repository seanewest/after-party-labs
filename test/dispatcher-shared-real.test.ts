import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAppServerClient } from "../dispatcher/app-server-client.ts";
import { DispatcherQueue } from "../dispatcher/queue.ts";
import { WorkerSessionStore } from "../dispatcher/session-store.ts";
import { SharedWorkerDeliveryPrototype } from "../dispatcher/shared-worker-prototype.ts";
import { TmuxWorkerTerminal } from "../dispatcher/tmux-runner.ts";
import { FlockWorkerClientLock } from "../dispatcher/worker-lock.ts";

const enabled = process.env.PARTY_REAL_SHARED_CODEX_SMOKE === "1";
const hasTools =
  spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0 &&
  spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;

test(
  "shared app-server turn stays visible and steerable through remote TUI clients",
  { skip: !enabled || !hasTools, timeout: 240_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "after-party-shared-real-"));
    const worktree = join(directory, "worktree");
    const codexHome = join(directory, "codex-home");
    const databasePath = join(directory, "dispatcher.sqlite");
    const imagePath = join(directory, "one-pixel.png");
    const socket = `after-party-shared-${process.pid}-${Date.now()}`;
    const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const sourceAuth = join(sourceHome, "auth.json");
    assert.ok(existsSync(sourceAuth), `Missing Codex authentication at ${sourceAuth}.`);

    mkdirSync(worktree, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q", worktree]).status, 0);
    mkdirSync(codexHome, { recursive: true });
    copyFileSync(sourceAuth, join(codexHome, "auth.json"));
    writeFileSync(
      join(codexHome, "config.toml"),
      `approval_policy = "never"\nsandbox_mode = "read-only"\n` +
        `[projects.${JSON.stringify(worktree)}]\ntrust_level = "trusted"\n`,
      "utf8",
    );
    writeFileSync(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const port = await availablePort();
    const endpoint = `ws://127.0.0.1:${port}`;
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const queue = new DispatcherQueue(databasePath);
    const sessions = new WorkerSessionStore(databasePath);
    sessions.configureWorker("daria", worktree);
    const appServer = spawn(process.execPath, [
      join(process.cwd(), "dispatcher", "party.ts"),
      "--database",
      databasePath,
      "shared-server",
      "daria",
      "--listen",
      endpoint,
    ], {
      cwd: worktree,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let appServerOutput = "";
    appServer.stdout.on("data", (value) => (appServerOutput += String(value)));
    appServer.stderr.on("data", (value) => (appServerOutput += String(value)));

    const terminal = new TmuxWorkerTerminal({
      tmuxArgsPrefix: ["-L", socket],
      remoteEndpoint: endpoint,
    });

    try {
      const setup = await connectEventually(endpoint, appServerOutput);
      const competingOwner = await new FlockWorkerClientLock(databasePath).tryAcquire(
        "daria",
      );
      assert.equal(competingOwner, null, "shared server must exclude a second thread owner");
      const thread = await setup.startThread(worktree);
      const setupTurn = await setup.startTurn(thread.id, [
        { type: "text", text: "Do not use tools. Reply with exactly SHARED_SETUP_63." },
      ]);
      await setup.waitForTurnCompletion(setupTurn.id, 60_000);
      setup.close();

      sessions.registerSession({
        name: "daria",
        cwd: worktree,
        sessionId: thread.id,
        hookRevision: "shared-real-test",
      });
      queue.setWorkerAvailability("daria", "idle");
      terminal.start(sessions.requireWorker("daria"));
      keepExitedPane(socket, terminal.sessionName("daria"));
      await waitForPane(socket, terminal.sessionName("daria"), "SHARED_SETUP_63", 1, 30_000);

      const message = queue.enqueue({
        sender: "morpheus",
        recipient: "daria",
        payload: {
          text:
            "Reply first with exactly DISPATCH_VISIBLE_63 as commentary. Then run `sleep 25`. " +
            "After it finishes, reply with exactly DISPATCH_ORIGINAL_63.",
        },
      });
      const delivery = new SharedWorkerDeliveryPrototype(queue, sessions, {
        endpoint,
        recipient: "daria",
        turnTimeoutMs: 90_000,
      }).deliverOnce();

      await waitForPane(
        socket,
        terminal.sessionName("daria"),
        "DISPATCH_VISIBLE_63",
        2,
        45_000,
      );
      startObserver(socket, "observer-one", worktree, thread.id, endpoint);
      keepExitedPane(socket, "observer-one");
      await waitForPane(socket, "observer-one", "DISPATCH_VISIBLE_63", 2, 30_000);

      terminal.inject(
        "daria",
        "Steering update: replace the requested final marker with exactly LIVE_STEER_SUCCEEDED_63.",
      );
      await waitForPane(socket, "observer-one", "Steering update:", 1, 15_000);
      killSession(socket, "observer-one");
      startObserver(socket, "observer-two", worktree, thread.id, endpoint);
      keepExitedPane(socket, "observer-two");
      await waitForPane(socket, "observer-two", "Steering update:", 1, 30_000);

      const delivered = await delivery;
      assert.equal(delivered.outcome, "completed");
      assert.equal(queue.getMessage(message.id)?.state, "completed");
      const receiptDetails = queue.inspect(message.id).receipt?.details;
      assert.ok(
        receiptDetails && typeof receiptDetails === "object" && !Array.isArray(receiptDetails),
      );
      assert.equal(receiptDetails.source, "codex-app-server");
      await waitForPane(
        socket,
        "observer-two",
        "LIVE_STEER_SUCCEEDED_63",
        2,
        45_000,
      );

      terminal.inject(
        "daria",
        "Do not use tools. Reply with exactly AFTER_COMPLETION_CHAT_63.",
      );
      await waitForPane(
        socket,
        terminal.sessionName("daria"),
        "AFTER_COMPLETION_CHAT_63",
        2,
        45_000,
      );

      startObserver(
        socket,
        "image-observer",
        worktree,
        thread.id,
        endpoint,
        imagePath,
        "Inspect the attached image, but reply with exactly IMAGE_CHAT_63.",
      );
      keepExitedPane(socket, "image-observer");
      await waitForPane(socket, "image-observer", "IMAGE_CHAT_63", 1, 60_000);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `App-server output:\n${appServerOutput}`,
      );
    } finally {
      for (const session of [
        terminal.sessionName("daria"),
        "observer-one",
        "observer-two",
        "image-observer",
      ]) {
        killSession(socket, session);
      }
      sessions.close();
      queue.close();
      spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
      appServer.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => appServer.once("close", resolve)),
        delay(2_000),
      ]);
      if (previousHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousHome;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

async function connectEventually(
  endpoint: string,
  output: string,
): Promise<CodexAppServerClient> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      return await CodexAppServerClient.connect(endpoint, { connectTimeoutMs: 1_000 });
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`App-server did not become ready: ${String(lastError)}\n${output}`);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function startObserver(
  socket: string,
  session: string,
  worktree: string,
  threadId: string,
  endpoint: string,
  imagePath?: string,
  prompt?: string,
): void {
  const codex = [
    "codex",
    "resume",
    threadId,
    "--remote",
    endpoint,
    "--no-alt-screen",
    "-C",
    worktree,
    ...(imagePath ? ["-i", imagePath] : []),
    ...(prompt ? [prompt] : []),
  ];
  const result = spawnSync(
    "tmux",
    [
      "-L",
      socket,
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      worktree,
      `exec ${codex.map(shellQuote).join(" ")}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

async function waitForPane(
  socket: string,
  session: string,
  expected: string,
  occurrences: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastPane = "";
  while (Date.now() <= deadline) {
    const captured = spawnSync(
      "tmux",
      ["-L", socket, "capture-pane", "-p", "-S", "-1000", "-t", `=${session}:0.0`],
      { encoding: "utf8" },
    );
    lastPane = captured.stdout;
    if (
      captured.status === 0 &&
      captured.stdout.split(expected).length - 1 >= occurrences
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${expected} in ${session}. Last pane:\n${lastPane}`);
}

function keepExitedPane(socket: string, session: string): void {
  spawnSync(
    "tmux",
    ["-L", socket, "set-option", "-w", "-t", `=${session}:0`, "remain-on-exit", "on"],
    { encoding: "utf8" },
  );
}

function killSession(socket: string, session: string): void {
  spawnSync("tmux", ["-L", socket, "kill-session", "-t", `=${session}`], {
    encoding: "utf8",
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
