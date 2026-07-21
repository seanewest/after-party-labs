import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";

const applicationDirectory = "after-party";

export function defaultDispatcherDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.PARTY_DISPATCHER_DB) {
    return resolve(environment.PARTY_DISPATCHER_DB);
  }

  const stateHome = environment.XDG_STATE_HOME
    ? resolve(environment.XDG_STATE_HOME)
    : join(homedir(), ".local", "state");

  return join(stateHome, applicationDirectory, "dispatcher.sqlite");
}

export function dispatcherDatabaseDirectory(databasePath: string): string | null {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) {
    return null;
  }

  return dirname(resolve(databasePath));
}

export function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) {
    return;
  }

  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}
