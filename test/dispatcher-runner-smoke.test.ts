import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import type { WorkerSessionRecord } from "../dispatcher/session-store.ts";
import { TmuxWorkerTerminal } from "../dispatcher/tmux-runner.ts";

const hasLocalTools =
  spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0 &&
  spawnSync("codex", ["resume", "--help"], { encoding: "utf8" }).status === 0;

test(
  "local Codex and isolated tmux smoke covers saved-session resume and prompt injection",
  { skip: !hasLocalTools },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "after-party-tmux-smoke-"));
    const worktree = join(directory, "worktree");
    const fakeCodex = join(directory, "fake-codex.mjs");
    const logPath = join(directory, "codex.log");
    const socket = `after-party-smoke-${process.pid}-${Date.now()}`;
    mkdirSync(join(worktree, ".git"), { recursive: true });
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.PARTY_SMOKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (value) => appendFileSync(process.env.PARTY_SMOKE_LOG, value));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    chmodSync(fakeCodex, 0o755);
    const previousLog = process.env.PARTY_SMOKE_LOG;
    process.env.PARTY_SMOKE_LOG = logPath;
    const terminal = new TmuxWorkerTerminal({
      tmuxArgsPrefix: ["-L", socket],
      codexCommand: fakeCodex,
    });
    const worker: WorkerSessionRecord = {
      name: "cornholio",
      worktreePath: worktree,
      sessionId: "33333333-3333-4333-8333-333333333333",
      transcriptPath: null,
      hookRevision: "1",
      lastEvent: "SessionStart",
      lastEventAt: 1,
      activeTurnId: null,
      activeMessageId: null,
      updatedAt: 1,
    };

    try {
      terminal.start(worker);
      assert.equal(terminal.hasSession("cornholio"), true);
      terminal.inject("cornholio", "[AFTER_PARTY_HANDOFF_V1:test]\nsmoke prompt");
      const log = await waitForLog(logPath, "smoke prompt", 2_000);
      assert.match(log, /"resume","33333333-3333-4333-8333-333333333333","-C"/);
      assert.match(log, /smoke prompt/);

      spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
      writeFileSync(logPath, "", "utf8");
      terminal.start(worker);
      const resumed = await waitForLog(logPath, SESSION_ID_FRAGMENT, 2_000);
      assert.match(resumed, /"resume","33333333-3333-4333-8333-333333333333","-C"/);

      const help = spawnSync("codex", ["resume", "--help"], { encoding: "utf8" });
      assert.equal(help.status, 0);
      assert.match(help.stdout, /Usage: codex resume/);
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
      if (previousLog === undefined) {
        delete process.env.PARTY_SMOKE_LOG;
      } else {
        process.env.PARTY_SMOKE_LOG = previousLog;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

const SESSION_ID_FRAGMENT = "33333333-3333-4333-8333-333333333333";

async function waitForLog(path: string, expected: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const content = readFileSync(path, "utf8");
      if (content.includes(expected)) {
        return content;
      }
    } catch {
      // The fake process may not have created the log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} in the tmux smoke log.`);
}
