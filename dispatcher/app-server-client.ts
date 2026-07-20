export type CodexUserInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "image"; url: string };

export interface CodexAppServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface StartedThread {
  id: string;
}

export interface StartedTurn {
  id: string;
}

interface AppServerSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
    options?: { once?: boolean },
  ): void;
  addEventListener(
    type: "error",
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
}

export interface CodexAppServerClientOptions {
  clientName?: string;
  clientVersion?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  socketFactory?: (endpoint: string) => AppServerSocket;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface TerminalWaiter {
  resolve(notification: CodexAppServerNotification): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerError extends Error {}

/**
 * Small, version-pinned JSON-RPC client used by the Task #63 prototype.
 *
 * It deliberately exposes raw notifications. The dispatcher already has the
 * reviewed StructuredTurnOutcomeMonitor and should classify outcomes there,
 * instead of duplicating provider-error policy in this experimental adapter.
 */
export class CodexAppServerClient {
  readonly endpoint: string;

  #socket: AppServerSocket;
  #requestTimeoutMs: number;
  #nextRequestId = 0;
  #pending = new Map<number, PendingRequest>();
  #listeners = new Set<(notification: CodexAppServerNotification) => void>();
  #terminal = new Map<string, CodexAppServerNotification>();
  #terminalWaiters = new Map<string, TerminalWaiter>();
  #closed = false;

  private constructor(
    endpoint: string,
    socket: AppServerSocket,
    requestTimeoutMs: number,
  ) {
    this.endpoint = endpoint;
    this.#socket = socket;
    this.#requestTimeoutMs = requestTimeoutMs;
    socket.addEventListener("message", (event) => this.#handleMessage(event.data));
    socket.addEventListener("close", (event) => {
      this.#failAll(
        new CodexAppServerError(
          `Codex app-server connection closed (${String(event.code ?? "unknown")}): ` +
            `${event.reason?.trim() || "no reason"}.`,
        ),
      );
    });
    socket.addEventListener("error", () => {
      this.#failAll(new CodexAppServerError("Codex app-server WebSocket failed."));
    });
  }

  static async connect(
    endpoint: string,
    options: CodexAppServerClientOptions = {},
  ): Promise<CodexAppServerClient> {
    const normalizedEndpoint = validateLocalAppServerEndpoint(endpoint);
    const connectTimeoutMs = duration(
      options.connectTimeoutMs ?? 10_000,
      "connect timeout",
    );
    const requestTimeoutMs = duration(
      options.requestTimeoutMs ?? 30_000,
      "request timeout",
    );
    const socket = (options.socketFactory ?? defaultSocketFactory)(normalizedEndpoint);
    await waitForOpen(socket, connectTimeoutMs);
    const client = new CodexAppServerClient(
      normalizedEndpoint,
      socket,
      requestTimeoutMs,
    );
    await client.#request("initialize", {
      clientInfo: {
        name: nonEmpty(options.clientName ?? "after-party-dispatcher", "client name"),
        title: "After Party dispatcher prototype",
        version: nonEmpty(options.clientVersion ?? "0.1", "client version"),
      },
    });
    client.#notify("initialized");
    return client;
  }

  onNotification(
    listener: (notification: CodexAppServerNotification) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async startThread(cwd: string): Promise<StartedThread> {
    const result = requireObject(
      await this.#request("thread/start", {
        cwd: nonEmpty(cwd, "thread cwd"),
        ephemeral: false,
      }),
      "thread/start result",
    );
    const thread = requireObject(result.thread, "started thread");
    return { id: requireString(thread.id, "started thread ID") };
  }

  async resumeThread(threadId: string, cwd?: string): Promise<StartedThread> {
    const result = requireObject(
      await this.#request("thread/resume", {
        threadId: requireString(threadId, "thread ID"),
        ...(cwd ? { cwd: nonEmpty(cwd, "thread cwd") } : {}),
      }),
      "thread/resume result",
    );
    const thread = requireObject(result.thread, "resumed thread");
    return { id: requireString(thread.id, "resumed thread ID") };
  }

  async startTurn(threadId: string, input: CodexUserInput[]): Promise<StartedTurn> {
    const result = requireObject(
      await this.#request("turn/start", {
        threadId: requireString(threadId, "thread ID"),
        input: requireInput(input),
      }),
      "turn/start result",
    );
    const turn = requireObject(result.turn, "started turn");
    return { id: requireString(turn.id, "started turn ID") };
  }

  async steerTurn(
    threadId: string,
    expectedTurnId: string,
    input: CodexUserInput[],
  ): Promise<string> {
    const result = requireObject(
      await this.#request("turn/steer", {
        threadId: requireString(threadId, "thread ID"),
        expectedTurnId: requireString(expectedTurnId, "expected turn ID"),
        input: requireInput(input),
      }),
      "turn/steer result",
    );
    return requireString(result.turnId, "steered turn ID");
  }

  waitForTurnCompletion(
    turnId: string,
    timeoutMs = 300_000,
  ): Promise<CodexAppServerNotification> {
    const id = requireString(turnId, "turn ID");
    const observed = this.#terminal.get(id);
    if (observed) {
      return Promise.resolve(observed);
    }
    if (this.#closed) {
      return Promise.reject(new CodexAppServerError("Codex app-server client is closed."));
    }
    if (this.#terminalWaiters.has(id)) {
      return Promise.reject(
        new CodexAppServerError(`Turn ${id} already has a completion waiter.`),
      );
    }
    const timeout = duration(timeoutMs, "turn timeout");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#terminalWaiters.delete(id);
        reject(new CodexAppServerError(`Timed out waiting for Codex turn ${id}.`));
      }, timeout);
      this.#terminalWaiters.set(id, { resolve, reject, timer });
    });
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#socket.close(1000, "prototype client complete");
      this.#failAll(new CodexAppServerError("Codex app-server client closed."));
    }
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new CodexAppServerError("Codex app-server client is closed."));
    }
    const id = ++this.#nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexAppServerError(`Codex app-server request ${method} timed out.`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  #notify(method: string, params?: Record<string, unknown>): void {
    this.#socket.send(JSON.stringify({ method, ...(params ? { params } : {}) }));
  }

  #handleMessage(data: unknown): void {
    let message: Record<string, unknown>;
    try {
      const value = JSON.parse(messageText(data)) as unknown;
      message = requireObject(value, "app-server message");
    } catch (error) {
      this.#socket.close(1002, "invalid app-server message");
      this.#failAll(
        new CodexAppServerError(
          `Codex app-server sent an invalid message: ${String(error)}`,
        ),
      );
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = isObject(message.error) ? message.error : {};
        pending.reject(
          new CodexAppServerError(
            `Codex app-server request failed (${String(error.code ?? "unknown")}): ` +
              `${String(error.message ?? "unknown error")}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") {
      return;
    }
    const notification: CodexAppServerNotification = {
      method: message.method,
      ...(isObject(message.params) ? { params: message.params } : {}),
    };
    for (const listener of this.#listeners) {
      listener(notification);
    }
    const turnId = terminalTurnId(notification);
    if (!turnId) {
      return;
    }
    this.#terminal.set(turnId, notification);
    const waiter = this.#terminalWaiters.get(turnId);
    if (waiter) {
      this.#terminalWaiters.delete(turnId);
      clearTimeout(waiter.timer);
      waiter.resolve(notification);
    }
  }

  #failAll(error: Error): void {
    if (this.#closed && this.#pending.size === 0 && this.#terminalWaiters.size === 0) {
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#terminalWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#terminalWaiters.clear();
  }
}

function terminalTurnId(notification: CodexAppServerNotification): string | null {
  if (notification.method !== "turn/completed") {
    return null;
  }
  const turn = isObject(notification.params?.turn) ? notification.params.turn : null;
  return typeof turn?.id === "string" && turn.id.trim() ? turn.id : null;
}

function defaultSocketFactory(endpoint: string): AppServerSocket {
  return new WebSocket(endpoint) as unknown as AppServerSocket;
}

function waitForOpen(socket: AppServerSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === 1) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new CodexAppServerError("Timed out connecting to Codex app-server."));
    }, timeoutMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new CodexAppServerError("Could not connect to Codex app-server."));
      },
      { once: true },
    );
  });
}

export function validateLocalAppServerEndpoint(value: string): string {
  const endpoint = nonEmpty(value, "app-server endpoint");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CodexAppServerError("App-server endpoint must be a ws:// localhost URL.");
  }
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new CodexAppServerError(
      "The prototype accepts only a local ws:// app-server endpoint.",
    );
  }
  return endpoint;
}

function requireInput(input: CodexUserInput[]): CodexUserInput[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new CodexAppServerError("Codex turn input must not be empty.");
  }
  return input;
}

function messageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("utf8");
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  throw new CodexAppServerError("Codex app-server sent an unsupported frame type.");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new CodexAppServerError(`${label} must be an object.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new CodexAppServerError(`${label} must be a string.`);
  }
  return nonEmpty(value, label);
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CodexAppServerError(`${label} must not be empty.`);
  }
  return normalized;
}

function duration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CodexAppServerError(`${label} must be a positive integer.`);
  }
  return value;
}
