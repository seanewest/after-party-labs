import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANAGED_HOOK_DESCRIPTION =
  "After Party named-worker lifecycle hooks. Managed by party hooks.";

export type HookInstallationStatus =
  | "missing"
  | "current"
  | "update_available"
  | "conflict";

export interface HookInstallationOptions {
  environment?: NodeJS.ProcessEnv;
  handlerPath?: string;
  targetPath?: string;
}

export interface HookInstallationInspection {
  status: HookInstallationStatus;
  targetPath: string;
  command: string;
}

export class HookInstallationError extends Error {}

export function managedHookConfiguration(handlerPath: string) {
  const command = `/usr/bin/env node ${shellQuote(resolve(handlerPath))}`;
  const hook = (statusMessage: string) => [
    {
      hooks: [
        {
          type: "command",
          command,
          statusMessage,
        },
      ],
    },
  ];

  return {
    description: MANAGED_HOOK_DESCRIPTION,
    hooks: {
      SessionStart: hook("Registering named After Party worker"),
      UserPromptSubmit: hook("Recording After Party worker activity"),
      Stop: hook("Completing After Party worker activity"),
    },
  };
}

export function inspectHookInstallation(
  options: HookInstallationOptions = {},
): HookInstallationInspection {
  const targetPath = hookTargetPath(options);
  const desired = managedHookConfiguration(handlerPath(options));
  const command = desired.hooks.SessionStart[0].hooks[0].command;
  if (!existsSync(targetPath)) {
    return { status: "missing", targetPath, command };
  }

  const existing = readConfiguration(targetPath);
  if (!isManagedConfiguration(existing)) {
    return { status: "conflict", targetPath, command };
  }
  return {
    status: configurationsEqual(existing, desired) ? "current" : "update_available",
    targetPath,
    command,
  };
}

export function installHooks(
  options: HookInstallationOptions = {},
): HookInstallationInspection {
  const inspection = inspectHookInstallation(options);
  if (inspection.status === "conflict") {
    throw new HookInstallationError(
      `Refusing to overwrite unrelated Codex hooks at ${inspection.targetPath}.`,
    );
  }
  if (inspection.status === "current") {
    return inspection;
  }

  const desired = managedHookConfiguration(handlerPath(options));
  mkdirSync(dirname(inspection.targetPath), { recursive: true });
  const temporaryPath = `${inspection.targetPath}.after-party-${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(desired, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, inspection.targetPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return inspectHookInstallation(options);
}

export function uninstallHooks(
  options: HookInstallationOptions = {},
): HookInstallationInspection {
  const inspection = inspectHookInstallation(options);
  if (inspection.status === "conflict") {
    throw new HookInstallationError(
      `Refusing to remove unrelated Codex hooks at ${inspection.targetPath}.`,
    );
  }
  if (inspection.status !== "missing") {
    rmSync(inspection.targetPath);
  }
  return inspectHookInstallation(options);
}

export function resolvePrimaryCheckout(repositoryPath = moduleRepositoryPath()): string {
  const result = spawnSync(
    "git",
    ["-C", repositoryPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new HookInstallationError(
      `Cannot locate the primary After Party checkout: ${result.stderr.trim()}`,
    );
  }
  return dirname(result.stdout.trim());
}

function moduleRepositoryPath(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function handlerPath(options: HookInstallationOptions): string {
  const path = options.handlerPath
    ? resolve(options.handlerPath)
    : join(resolvePrimaryCheckout(), "dispatcher", "hooks", "lifecycle.ts");
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new HookInstallationError(`Lifecycle hook handler does not exist at ${path}.`);
  }
  return path;
}

function hookTargetPath(options: HookInstallationOptions): string {
  if (options.targetPath) {
    return resolve(options.targetPath);
  }
  const environment = options.environment ?? process.env;
  const codexHome = environment.CODEX_HOME
    ? resolve(environment.CODEX_HOME)
    : join(homedir(), ".codex");
  return join(codexHome, "hooks.json");
}

function readConfiguration(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isManagedConfiguration(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).description === MANAGED_HOOK_DESCRIPTION,
  );
}

function configurationsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
