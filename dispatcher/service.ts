import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { defaultDispatcherDatabasePath } from "./paths.ts";

const MARKER = "# Managed by After Party persistent goal dispatcher v1";
const UNIT = "after-party-dispatcher.service";

export interface InstallDispatcherServiceOptions {
  owner: string;
  projectNumber: number;
  checkout: string;
  databasePath?: string;
  unitPath?: string;
  nodePath?: string;
  partyPath?: string;
  pathEnvironment?: string;
  run?: (command: string, arguments_: string[]) => string;
}

export interface DispatcherServiceStatus {
  unitPath: string;
  installed: boolean;
  active: string;
  enabled: string;
}

export function installDispatcherService(
  options: InstallDispatcherServiceOptions,
): DispatcherServiceStatus {
  const unitPath = options.unitPath ?? defaultUnitPath();
  const existing = existsSync(unitPath) ? readFileSync(unitPath, "utf8") : null;
  if (existing && !existing.startsWith(MARKER)) {
    throw new Error(`Refusing to overwrite unmanaged systemd unit ${unitPath}.`);
  }
  const checkout = primaryCheckout(resolve(options.checkout));
  const databasePath = options.databasePath ?? defaultDispatcherDatabasePath();
  const nodePath = options.nodePath ?? process.execPath;
  const partyPath =
    options.partyPath ?? join(checkout, "dispatcher", "party.ts");
  const pathEnvironment = options.pathEnvironment ?? process.env.PATH ?? "";
  const body = `${MARKER}
[Unit]
Description=After Party persistent goal-context dispatcher
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdValue(checkout)}
Environment=PATH=${systemdValue(pathEnvironment)}
ExecStart=${[nodePath, partyPath, "--database", databasePath, "run", "--owner", options.owner, "--project", String(options.projectNumber), "--checkout", checkout].map(systemdValue).join(" ")}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=default.target
`;
  mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
  writeFileSync(unitPath, body, { mode: 0o600 });
  const run = options.run ?? runCommand;
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", UNIT]);
  run("systemctl", ["--user", "restart", UNIT]);
  return dispatcherServiceStatus({ unitPath, run });
}

export function uninstallDispatcherService(options: {
  unitPath?: string;
  run?: (command: string, arguments_: string[]) => string;
} = {}): DispatcherServiceStatus {
  const unitPath = options.unitPath ?? defaultUnitPath();
  const run = options.run ?? runCommand;
  if (!existsSync(unitPath)) {
    return dispatcherServiceStatus({ unitPath, run });
  }
  if (!readFileSync(unitPath, "utf8").startsWith(MARKER)) {
    throw new Error(`Refusing to remove unmanaged systemd unit ${unitPath}.`);
  }
  run("systemctl", ["--user", "disable", "--now", UNIT]);
  const active = safeStatus(run, ["--user", "is-active", UNIT]);
  if (active === "active" || active === "activating") {
    throw new Error(`Refusing to remove ${unitPath}; ${UNIT} is still ${active}.`);
  }
  rmSync(unitPath);
  run("systemctl", ["--user", "daemon-reload"]);
  return dispatcherServiceStatus({ unitPath, run });
}

export function controlDispatcherService(
  action: "start" | "stop" | "restart",
  run: (command: string, arguments_: string[]) => string = runCommand,
): DispatcherServiceStatus {
  run("systemctl", ["--user", action, UNIT]);
  return dispatcherServiceStatus({ run });
}

export function dispatcherServiceStatus(options: {
  unitPath?: string;
  run?: (command: string, arguments_: string[]) => string;
} = {}): DispatcherServiceStatus {
  const unitPath = options.unitPath ?? defaultUnitPath();
  const run = options.run ?? runCommand;
  return {
    unitPath,
    installed: existsSync(unitPath),
    active: safeStatus(run, ["--user", "is-active", UNIT]),
    enabled: safeStatus(run, ["--user", "is-enabled", UNIT]),
  };
}

export function dispatcherServiceLogs(
  lines = 100,
  run: (command: string, arguments_: string[]) => string = runCommand,
): string {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10_000) {
    throw new Error("Service log lines must be between 1 and 10000.");
  }
  return run("journalctl", [
    "--user-unit",
    UNIT,
    "--no-pager",
    "--lines",
    String(lines),
  ]);
}

function defaultUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", UNIT);
}

function primaryCheckout(checkout: string): string {
  try {
    const common = execFileSync(
      "git",
      ["-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return dirname(common);
  } catch {
    return checkout;
  }
}

function systemdValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function runCommand(command: string, arguments_: string[]): string {
  return execFileSync(command, arguments_, { encoding: "utf8" }).trim();
}

function safeStatus(
  run: (command: string, arguments_: string[]) => string,
  arguments_: string[],
): string {
  try {
    return run("systemctl", arguments_) || "unknown";
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" && stdout.trim() ? stdout.trim() : "inactive";
  }
}
