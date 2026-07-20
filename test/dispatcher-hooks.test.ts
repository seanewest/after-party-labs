import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectHookInstallation,
  installHooks,
  MANAGED_HOOK_DESCRIPTION,
  managedHookConfiguration,
  resolvePrimaryCheckout,
  uninstallHooks,
} from "../dispatcher/hook-installation.ts";

test("managed user hooks install all three lifecycle events idempotently", () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-hook-install-"));
  const targetPath = join(directory, ".codex", "hooks.json");
  const handlerPath = join(directory, "primary checkout", "dispatcher", "hooks", "lifecycle.ts");
  const options = { targetPath, handlerPath };
  try {
    mkdirSync(join(directory, "primary checkout", "dispatcher", "hooks"), {
      recursive: true,
    });
    writeFileSync(handlerPath, "// test lifecycle handler\n");
    assert.equal(inspectHookInstallation(options).status, "missing");
    assert.equal(installHooks(options).status, "current");
    assert.equal(installHooks(options).status, "current");

    const configuration = JSON.parse(readFileSync(targetPath, "utf8")) as {
      description?: string;
      hooks?: Record<
        string,
        Array<{ hooks?: Array<{ type?: string; command?: string }> }>
      >;
    };
    assert.equal(configuration.description, MANAGED_HOOK_DESCRIPTION);
    assert.deepEqual(Object.keys(configuration.hooks ?? {}).sort(), [
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    for (const event of Object.values(configuration.hooks ?? {})) {
      assert.equal(event.length, 1);
      assert.equal(event[0]?.hooks?.length, 1);
      assert.equal(event[0]?.hooks?.[0]?.type, "command");
      assert.equal(
        event[0]?.hooks?.[0]?.command,
        `/usr/bin/env node '${handlerPath}'`,
      );
    }

    assert.equal(uninstallHooks(options).status, "missing");
    assert.equal(uninstallHooks(options).status, "missing");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("managed user hooks update their handler path but never overwrite other hooks", () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-hook-safety-"));
  const targetPath = join(directory, "hooks.json");
  try {
    writeFileSync(join(directory, "old-handler.ts"), "// old\n");
    writeFileSync(join(directory, "new-handler.ts"), "// new\n");
    writeFileSync(
      targetPath,
      `${JSON.stringify(managedHookConfiguration(join(directory, "old-handler.ts")), null, 2)}\n`,
    );
    const managedOptions = { targetPath, handlerPath: join(directory, "new-handler.ts") };
    assert.equal(inspectHookInstallation(managedOptions).status, "update_available");
    assert.equal(installHooks(managedOptions).status, "current");

    const personal = '{"description":"personal hooks","hooks":{}}\n';
    writeFileSync(targetPath, personal);
    assert.equal(inspectHookInstallation(managedOptions).status, "conflict");
    assert.throws(() => installHooks(managedOptions), /Refusing to overwrite unrelated/);
    assert.throws(() => uninstallHooks(managedOptions), /Refusing to remove unrelated/);
    assert.equal(readFileSync(targetPath, "utf8"), personal);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("user hook installation resolves the primary checkout from a linked worktree", () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-hook-path-"));
  const primary = join(directory, "primary");
  const linked = join(directory, "linked");
  try {
    mkdirSync(primary);
    assert.equal(spawnSync("git", ["init", "-q", primary]).status, 0);
    assert.equal(
      spawnSync("git", [
        "-C",
        primary,
        "-c",
        "user.name=After Party Test",
        "-c",
        "user.email=after-party-test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ]).status,
      0,
    );
    assert.equal(
      spawnSync("git", ["-C", primary, "worktree", "add", "-q", "-b", "linked", linked])
        .status,
      0,
    );
    assert.equal(resolvePrimaryCheckout(linked), primary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
