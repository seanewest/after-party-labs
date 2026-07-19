import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LifecycleHandler } from "../dispatcher/lifecycle.ts";
import { DispatcherQueue } from "../dispatcher/queue.ts";
import { WorkerSessionStore } from "../dispatcher/session-store.ts";
import { TmuxWorkerTerminal } from "../dispatcher/tmux-runner.ts";
import { CodexExecTurnOutcomeSource } from "../dispatcher/turn-outcome.ts";
import { DeliveryCoordinator } from "../dispatcher/worker-runner.ts";

const enabled = process.env.PARTY_REAL_CODEX_SMOKE === "1";
const hasTools =
  spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0 &&
  spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;

test(
  "real Codex smoke preserves one session across TUI delivery, automation, and later steering",
  { skip: !enabled || !hasTools, timeout: 180_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "after-party-real-codex-"));
    const worktree = join(directory, "worktree");
    const isolatedCodexHome = join(directory, "codex-home");
    const wrapper = join(directory, "codex-smoke");
    const socket = `after-party-real-${process.pid}-${Date.now()}`;
    const databasePath = join(directory, "dispatcher.sqlite");
    const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const sourceAuth = join(sourceCodexHome, "auth.json");
    assert.ok(existsSync(sourceAuth), `Missing Codex authentication at ${sourceAuth}.`);

    mkdirSync(worktree, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q", worktree]).status, 0);
    mkdirSync(isolatedCodexHome, { recursive: true });
    copyFileSync(sourceAuth, join(isolatedCodexHome, "auth.json"));
    writeFileSync(
      join(isolatedCodexHome, "config.toml"),
      `[projects.${JSON.stringify(worktree)}]\ntrust_level = "trusted"\n`,
      "utf8",
    );
    writeFileSync(
      wrapper,
      "#!/bin/sh\nexec codex --ask-for-approval never --sandbox read-only \"$@\"\n",
      "utf8",
    );
    chmodSync(wrapper, 0o755);

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = isolatedCodexHome;
    const queue = new DispatcherQueue(databasePath);
    const sessions = new WorkerSessionStore(databasePath);
    const terminal = new TmuxWorkerTerminal({
      tmuxArgsPrefix: ["-L", socket],
      codexCommand: wrapper,
    });

    try {
      sessions.configureWorker("cornholio", worktree);
      terminal.start(sessions.requireWorker("cornholio"));
      keepExitedPane(socket, terminal.sessionName("cornholio"));
      await waitForReadyPane(socket, terminal.sessionName("cornholio"), 30_000);
      terminal.inject(
        "cornholio",
        "Do not use tools. Reply with exactly TUI_READY_36.",
      );
      await waitForPane(socket, terminal.sessionName("cornholio"), "TUI_READY_36", 30_000);

      const sessionId = await waitForSessionId(isolatedCodexHome, worktree, 5_000);
      new LifecycleHandler(queue, sessions).handle({
        hook_event_name: "SessionStart",
        session_id: sessionId,
        transcript_path: join(directory, "smoke-transcript.jsonl"),
        cwd: worktree,
        source: "startup",
      });
      const message = queue.enqueue({
        sender: "morpheus",
        recipient: "cornholio",
        payload: {
          text: "Do not use tools. Reply with exactly AUTOMATED_READY_36.",
        },
      });
      const realSource = new CodexExecTurnOutcomeSource(queue, {
        codexCommand: wrapper,
      });
      const coordinator = new DeliveryCoordinator(queue, sessions, terminal, {
        consumer: "real-smoke",
        leaseMs: 30_000,
        pollMs: 25,
        turnOutcomeSource: {
          async waitForOutcome(accepted, worker, prompt) {
            assert.equal(terminal.hasSession("cornholio"), false);
            queue.recordReceipt(accepted.id, "cornholio", {
              turnId: "real-smoke-structured-turn",
            });
            queue.acknowledge(accepted.id);
            return realSource.waitForOutcome(accepted, worker, prompt);
          },
        },
      });

      const delivered = await coordinator.deliverOnce();
      assert.equal(delivered.outcome, "completed");
      assert.equal(queue.getMessage(message.id)?.state, "completed");
      assert.equal(terminal.hasSession("cornholio"), false);

      terminal.start(sessions.requireWorker("cornholio"));
      keepExitedPane(socket, terminal.sessionName("cornholio"));
      await waitForPane(
        socket,
        terminal.sessionName("cornholio"),
        "AUTOMATED_READY_36",
        30_000,
      );
      await waitForReadyPane(socket, terminal.sessionName("cornholio"), 30_000);
      terminal.inject(
        "cornholio",
        "Do not use tools. Reply with exactly STEERING_READY_36.",
      );
      await waitForPane(
        socket,
        terminal.sessionName("cornholio"),
        "STEERING_READY_36",
        60_000,
      );
    } finally {
      if (terminal.hasSession("cornholio")) {
        terminal.stop("cornholio");
      }
      sessions.close();
      queue.close();
      spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

async function waitForPane(
  socket: string,
  session: string,
  expected: string,
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
      captured.stdout.split(expected).length - 1 >= 2
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${expected} in the real Codex TUI. Last pane:\n${lastPane}`,
  );
}

async function waitForReadyPane(
  socket: string,
  session: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const captured = spawnSync(
      "tmux",
      ["-L", socket, "capture-pane", "-p", "-t", `=${session}:0.0`],
      { encoding: "utf8" },
    );
    if (
      captured.status === 0 &&
      captured.stdout.includes("›") &&
      !captured.stdout.includes("model:     loading") &&
      !captured.stdout.includes("Booting MCP server")
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the real Codex TUI composer.");
}

async function waitForSessionId(
  codexHome: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    for (const path of jsonlFiles(join(codexHome, "sessions"))) {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/u).slice(0, 10)) {
        if (!line.trim()) {
          continue;
        }
        const event = JSON.parse(line) as {
          type?: string;
          payload?: { id?: string; cwd?: string };
        };
        if (
          event.type === "session_meta" &&
          event.payload?.cwd === cwd &&
          event.payload.id
        ) {
          return event.payload.id;
        }
      }
    }
    await delay(100);
  }
  throw new Error("Timed out locating the real Codex smoke session ID.");
}

function jsonlFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const paths: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      paths.push(...jsonlFiles(path));
    } else if (path.endsWith(".jsonl")) {
      paths.push(path);
    }
  }
  return paths;
}

function keepExitedPane(socket: string, session: string): void {
  const result = spawnSync(
    "tmux",
    ["-L", socket, "set-option", "-w", "-t", `=${session}:0`, "remain-on-exit", "on"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
