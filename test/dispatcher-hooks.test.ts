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
  const oldHandler = join(
    directory,
    "old-primary",
    "dispatcher",
    "hooks",
    "lifecycle.ts",
  );
  const newHandler = join(
    directory,
    "new-primary",
    "dispatcher",
    "hooks",
    "lifecycle.ts",
  );
  try {
    mkdirSync(join(directory, "old-primary", "dispatcher", "hooks"), {
      recursive: true,
    });
    mkdirSync(join(directory, "new-primary", "dispatcher", "hooks"), {
      recursive: true,
    });
    writeFileSync(oldHandler, "// old\n");
    writeFileSync(newHandler, "// new\n");
    writeFileSync(
      targetPath,
      `${JSON.stringify(managedHookConfiguration(oldHandler), null, 2)}\n`,
    );
    const managedOptions = { targetPath, handlerPath: newHandler };
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

test("augmented managed files are conflicts for both install and uninstall", () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-hook-augmented-"));
  const targetPath = join(directory, "hooks.json");
  const handlerPath = join(directory, "primary", "dispatcher", "hooks", "lifecycle.ts");
  const options = { targetPath, handlerPath };
  try {
    mkdirSync(join(directory, "primary", "dispatcher", "hooks"), { recursive: true });
    writeFileSync(handlerPath, "// lifecycle\n");
    const managed = managedHookConfiguration(handlerPath);
    const extraHook = { ...managed.hooks.SessionStart[0].hooks[0] };
    const augmented: unknown[] = [
      { ...managed, personal: true },
      { ...managed, hooks: { ...managed.hooks, PreToolUse: [] } },
      {
        ...managed,
        hooks: {
          ...managed.hooks,
          SessionStart: [...managed.hooks.SessionStart, { hooks: [] }],
        },
      },
      {
        ...managed,
        hooks: {
          ...managed.hooks,
          SessionStart: [
            {
              hooks: [...managed.hooks.SessionStart[0].hooks, extraHook],
            },
          ],
        },
      },
      {
        ...managed,
        hooks: {
          ...managed.hooks,
          SessionStart: [
            { ...managed.hooks.SessionStart[0], matcher: "personal matcher" },
          ],
        },
      },
      {
        ...managed,
        hooks: {
          ...managed.hooks,
          SessionStart: [
            {
              hooks: [
                {
                  ...managed.hooks.SessionStart[0].hooks[0],
                  personal: true,
                },
              ],
            },
          ],
        },
      },
    ];

    for (const configuration of augmented) {
      const serialized = `${JSON.stringify(configuration, null, 2)}\n`;
      writeFileSync(targetPath, serialized);
      assert.equal(inspectHookInstallation(options).status, "conflict");
      assert.throws(() => installHooks(options), /Refusing to overwrite unrelated/);
      assert.throws(() => uninstallHooks(options), /Refusing to remove unrelated/);
      assert.equal(readFileSync(targetPath, "utf8"), serialized);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed hook files remain untouched conflicts", () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-hook-malformed-"));
  const targetPath = join(directory, "hooks.json");
  const handlerPath = join(directory, "primary", "dispatcher", "hooks", "lifecycle.ts");
  const options = { targetPath, handlerPath };
  try {
    mkdirSync(join(directory, "primary", "dispatcher", "hooks"), { recursive: true });
    writeFileSync(handlerPath, "// lifecycle\n");
    const malformed = [
      "{not valid json\n",
      `${JSON.stringify({ description: MANAGED_HOOK_DESCRIPTION, hooks: {} })}\n`,
      `${JSON.stringify({
        ...managedHookConfiguration(handlerPath),
        hooks: {
          ...managedHookConfiguration(handlerPath).hooks,
          Stop: [{ hooks: [{ type: "command" }] }],
        },
      })}\n`,
    ];

    for (const serialized of malformed) {
      writeFileSync(targetPath, serialized);
      assert.equal(inspectHookInstallation(options).status, "conflict");
      assert.throws(() => installHooks(options), /Refusing to overwrite unrelated/);
      assert.throws(() => uninstallHooks(options), /Refusing to remove unrelated/);
      assert.equal(readFileSync(targetPath, "utf8"), serialized);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uninstall removes an exact stale managed file after its handler disappears", () => {
  const directory = mkdtempSync(join(tmpdir(), "after-party-hook-stale-"));
  const targetPath = join(directory, "hooks.json");
  const handlerPath = join(directory, "old-primary", "dispatcher", "hooks", "lifecycle.ts");
  const options = { targetPath, handlerPath };
  try {
    mkdirSync(join(directory, "old-primary", "dispatcher", "hooks"), {
      recursive: true,
    });
    writeFileSync(handlerPath, "// lifecycle\n");
    writeFileSync(
      targetPath,
      `${JSON.stringify(managedHookConfiguration(handlerPath), null, 2)}\n`,
    );
    rmSync(handlerPath);

    const result = uninstallHooks(options);
    assert.equal(result.status, "missing");
    assert.equal(result.command, `/usr/bin/env node '${handlerPath}'`);
    assert.equal(uninstallHooks(options).status, "missing");
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
