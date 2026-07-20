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
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  command: string | null;
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
  let installed: ManagedConfiguration | null = null;
  if (existsSync(targetPath)) {
    installed = parseManagedConfiguration(readConfiguration(targetPath));
    if (!installed) {
      return { status: "conflict", targetPath, command: null };
    }
  }

  const desiredHandlerPath = handlerPath(options);
  const desired = managedHookConfiguration(desiredHandlerPath);
  const command = desired.hooks.SessionStart[0].hooks[0].command;
  if (!installed) {
    return { status: "missing", targetPath, command };
  }
  return {
    status:
      installed.handlerPath === desiredHandlerPath ? "current" : "update_available",
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
  const targetPath = hookTargetPath(options);
  if (!existsSync(targetPath)) {
    return { status: "missing", targetPath, command: null };
  }
  const installed = parseManagedConfiguration(readConfiguration(targetPath));
  if (!installed) {
    throw new HookInstallationError(
      `Refusing to remove unrelated Codex hooks at ${targetPath}.`,
    );
  }
  rmSync(targetPath);
  return { status: "missing", targetPath, command: installed.command };
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

interface ManagedConfiguration {
  command: string;
  handlerPath: string;
}

const managedEvents = {
  SessionStart: "Registering named After Party worker",
  UserPromptSubmit: "Recording After Party worker activity",
  Stop: "Completing After Party worker activity",
} as const;

function parseManagedConfiguration(value: unknown): ManagedConfiguration | null {
  if (!hasExactKeys(value, ["description", "hooks"])) {
    return null;
  }
  if (value.description !== MANAGED_HOOK_DESCRIPTION) {
    return null;
  }
  if (!hasExactKeys(value.hooks, Object.keys(managedEvents))) {
    return null;
  }

  let managedPath: string | null = null;
  let managedCommand: string | null = null;
  for (const [event, statusMessage] of Object.entries(managedEvents)) {
    const entries = value.hooks[event];
    if (!Array.isArray(entries) || entries.length !== 1) {
      return null;
    }
    const entry = entries[0];
    if (!hasExactKeys(entry, ["hooks"])) {
      return null;
    }
    const hooks = entry.hooks;
    if (!Array.isArray(hooks) || hooks.length !== 1) {
      return null;
    }
    const hook = hooks[0];
    if (!hasExactKeys(hook, ["type", "command", "statusMessage"])) {
      return null;
    }
    if (
      hook.type !== "command" ||
      typeof hook.command !== "string" ||
      hook.statusMessage !== statusMessage
    ) {
      return null;
    }
    const path = lifecycleHandlerPathFromCommand(hook.command);
    if (!path || (managedPath !== null && path !== managedPath)) {
      return null;
    }
    managedPath = path;
    managedCommand = hook.command;
  }

  if (!managedPath || !managedCommand) {
    return null;
  }
  return {
    command: managedCommand,
    handlerPath: managedPath,
  };
}

function hasExactKeys(value: unknown, expectedKeys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index])
  );
}

function lifecycleHandlerPathFromCommand(command: string): string | null {
  const prefix = "/usr/bin/env node ";
  if (!command.startsWith(prefix)) {
    return null;
  }
  const argument = command.slice(prefix.length);
  if (argument.length < 2 || !argument.startsWith("'") || !argument.endsWith("'")) {
    return null;
  }
  const quoteMarker = `'"'"'`;
  const decoded = argument.slice(1, -1).replaceAll(quoteMarker, "'");
  const suffix = join("dispatcher", "hooks", "lifecycle.ts");
  if (
    shellQuote(decoded) !== argument ||
    !isAbsolute(decoded) ||
    resolve(decoded) !== decoded ||
    !decoded.endsWith(`${sep}${suffix}`)
  ) {
    return null;
  }
  return decoded;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
