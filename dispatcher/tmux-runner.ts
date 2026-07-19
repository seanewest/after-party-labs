import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

import type { WorkerSessionRecord } from "./session-store.ts";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandExecutor = (
  command: string,
  args: string[],
  options?: SpawnSyncOptionsWithStringEncoding,
) => CommandResult;

export interface WorkerTerminal {
  hasSession(name: string): boolean;
  start(worker: WorkerSessionRecord): void;
  attach(name: string): void;
  inject(name: string, prompt: string): void;
}

export interface TmuxWorkerTerminalOptions {
  execute?: CommandExecutor;
  tmuxCommand?: string;
  tmuxArgsPrefix?: string[];
  codexCommand?: string;
}

export class TerminalRunnerError extends Error {}

export class TmuxWorkerTerminal implements WorkerTerminal {
  #execute: CommandExecutor;
  #tmuxCommand: string;
  #tmuxArgsPrefix: string[];
  #codexCommand: string;

  constructor(options: TmuxWorkerTerminalOptions = {}) {
    this.#execute = options.execute ?? executeCommand;
    this.#tmuxCommand = options.tmuxCommand ?? "tmux";
    this.#tmuxArgsPrefix = options.tmuxArgsPrefix ?? [];
    this.#codexCommand = options.codexCommand ?? "codex";
  }

  sessionName(name: string): string {
    return `after-party-${name}`;
  }

  hasSession(name: string): boolean {
    const result = this.#execute(
      this.#tmuxCommand,
      [...this.#tmuxArgsPrefix, "has-session", "-t", `=${this.sessionName(name)}`],
      commandOptions(),
    );
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TerminalRunnerError(`${this.#tmuxCommand} is not installed.`);
    }
    return result.status === 0;
  }

  start(worker: WorkerSessionRecord): void {
    if (this.hasSession(worker.name)) {
      return;
    }
    const codex = worker.sessionId
      ? [this.#codexCommand, "resume", worker.sessionId, "-C", worker.worktreePath]
      : [this.#codexCommand, "-C", worker.worktreePath];
    this.#checked(
      [
        ...this.#tmuxArgsPrefix,
        "new-session",
        "-d",
        "-s",
        this.sessionName(worker.name),
        "-c",
        worker.worktreePath,
        `exec ${codex.map(shellQuote).join(" ")}`,
      ],
      `start worker ${worker.name}`,
    );
  }

  attach(name: string): void {
    const result = this.#execute(
      this.#tmuxCommand,
      [...this.#tmuxArgsPrefix, "attach-session", "-t", `=${this.sessionName(name)}`],
      { encoding: "utf8", stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new TerminalRunnerError(`Could not attach worker ${name}.`);
    }
  }

  inject(name: string, prompt: string): void {
    const session = this.sessionName(name);
    const buffer = `after-party-${process.pid}-${Date.now()}`;
    this.#checked(
      [...this.#tmuxArgsPrefix, "load-buffer", "-b", buffer, "-"],
      `load handoff for ${name}`,
      prompt,
    );
    this.#checked(
      [...this.#tmuxArgsPrefix, "paste-buffer", "-d", "-b", buffer, "-t", `=${session}:0.0`],
      `paste handoff for ${name}`,
    );
    this.#checked(
      [...this.#tmuxArgsPrefix, "send-keys", "-t", `=${session}:0.0`, "Enter"],
      `submit handoff for ${name}`,
    );
  }

  #checked(args: string[], action: string, input?: string): void {
    const result = this.#execute(
      this.#tmuxCommand,
      args,
      commandOptions(input),
    );
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TerminalRunnerError(`${this.#tmuxCommand} is not installed.`);
    }
    if (result.status !== 0) {
      const detail = result.stderr.trim() || `exit ${String(result.status)}`;
      throw new TerminalRunnerError(`Could not ${action}: ${detail}`);
    }
  }
}

function executeCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding = commandOptions(),
): CommandResult {
  const result = spawnSync(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function commandOptions(input?: string): SpawnSyncOptionsWithStringEncoding {
  return {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
