import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CodexAppServerClient,
  validateLocalAppServerEndpoint,
  type CodexAppServerNotification,
  type CodexUserInput,
} from "./app-server-client.ts";
import { GoalContextStore } from "./goal-context.ts";

export interface GoalGatewayOptions {
  databasePath: string;
  contextId: string;
  host?: string;
  port: number;
  uploadDirectory: string;
  connect?: (endpoint: string) => Promise<CodexAppServerClient>;
}

interface BrowserInput {
  text?: unknown;
  image?: unknown;
  imageName?: unknown;
  mode?: unknown;
}

const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_HISTORY = 2_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class GoalGateway {
  #options: GoalGatewayOptions;
  #store: GoalContextStore;
  #client: CodexAppServerClient | null = null;
  #threadId: string | null = null;
  #activeTurnId: string | null = null;
  #history: CodexAppServerNotification[] = [];
  #listeners = new Set<ServerResponse>();
  #turnUploads = new Map<string, string[]>();
  #terminalTurns = new Set<string>();
  #followups: BrowserInput[] = [];
  #uploadDirectoryReady = false;
  #fatalResolve!: (error: Error) => void;
  readonly fatal = new Promise<Error>((resolve) => { this.#fatalResolve = resolve; });
  #session = randomUUID();
  #server = createServer((request, response) => void this.#handle(request, response));

  constructor(options: GoalGatewayOptions) {
    this.#options = options;
    this.#store = new GoalContextStore(options.databasePath);
    if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error("Goal gateway port must be between 1 and 65535.");
    }
    const host = options.host ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error("Goal gateway must listen on a loopback host.");
    }
  }

  async start(): Promise<void> {
    const context = this.#store.require(this.#options.contextId);
    if (!context.appEndpoint) {
      throw new Error(`Goal context ${context.id} has no app-server endpoint.`);
    }
    const endpoint = validateLocalAppServerEndpoint(context.appEndpoint);
    this.#client = await (this.#options.connect ?? CodexAppServerClient.connect)(endpoint);
    this.#client.onConnectionClosed?.((error) => this.#fatalResolve(error));
    this.#client.onNotification((notification) => this.#onNotification(notification));
    let thread;
    if (context.threadId) {
      try {
        thread = await this.#client.resumeThread(context.threadId, context.worktreePath);
      } catch (error) {
        if (context.threadHasActivity) {
          throw error;
        }
        // Codex does not persist a newly-created rollout until it has activity.
        // Replacing that provably empty thread is safe and is recorded below.
        thread = await this.#client.startThread(context.worktreePath);
      }
    } else {
      thread = await this.#client.startThread(context.worktreePath);
    }
    this.#threadId = thread.id;
    this.#activeTurnId = activeTurnFromSnapshot(thread.snapshot);
    this.#history.push({
      method: "conversation/snapshot",
      params: { entries: snapshotEntries(thread.snapshot) },
    });
    this.#store.updateRuntime(context.id, {
      threadId: thread.id,
      threadHasActivity: context.threadHasActivity || snapshotHasActivity(thread.snapshot),
      gatewayPid: process.pid,
      state: "running",
      pendingOperation: this.#activeTurnId ? `turn:${this.#activeTurnId}` : null,
      lastError: null,
    });
    const host = this.#options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#options.port, host, resolve);
    });
  }

  async stop(): Promise<void> {
    for (const listener of this.#listeners) {
      listener.end();
    }
    this.#listeners.clear();
    this.#client?.close();
    this.#client = null;
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    const context = this.#store.get(this.#options.contextId);
    if (context?.gatewayPid === process.pid) {
      this.#store.updateRuntime(context.id, {
        gatewayPid: null,
        state: "sleeping",
      });
    }
    this.#store.close();
  }

  #onNotification(notification: CodexAppServerNotification): void {
    const turnId = notificationTurnId(notification);
    if (turnId && notification.method === "turn/started") {
      this.#activeTurnId = turnId;
      this.#store.updateRuntime(this.#options.contextId, { threadHasActivity: true });
      const context = this.#store.require(this.#options.contextId);
      if (!context.pendingOperation) {
        this.#store.tryClaimOperation(context.id, `turn:${turnId}`);
      }
    }
    if (turnId && notification.method === "turn/completed") {
      this.#terminalTurns.add(turnId);
      if (!this.#activeTurnId || this.#activeTurnId === turnId) {
        this.#activeTurnId = null;
        this.#store.finishOperation(this.#options.contextId, `turn:${turnId}`);
        for (const path of this.#turnUploads.get(turnId) ?? []) {
          rmSync(path, { force: true });
        }
        this.#turnUploads.delete(turnId);
        const next = this.#followups.shift();
        if (next) queueMicrotask(() => void this.#submit(next).catch((error) => {
          this.#broadcast({ method: "conversation/error", params: { message: String(error) } });
        }));
      }
    }
    const rendered = renderNotification(notification);
    if (!rendered) return;
    this.#history.push(rendered);
    if (this.#history.length > MAX_HISTORY) {
      this.#history.splice(0, this.#history.length - MAX_HISTORY);
    }
    this.#broadcast(rendered);
  }

  #broadcast(notification: CodexAppServerNotification): void {
    const encoded = sse(notification);
    for (const listener of this.#listeners) {
      listener.write(encoded);
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.#validRequestHost(request)) {
        return send(response, 403, "Forbidden");
      }
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.#options.port}`);
      const base = `/contexts/${this.#options.contextId}`;
      if (request.method === "GET" && (url.pathname === base || url.pathname === `${base}/`)) {
        response.setHeader(
          "set-cookie",
          `after_party_context=${this.#session}; HttpOnly; SameSite=Strict; Path=${base}`,
        );
        return send(response, 200, terminalHtml(), "text/html; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === `${base}/client.js`) {
        return send(response, 200, terminalClient(), "text/javascript; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === `${base}/events`) {
        if (!this.#validSession(request)) {
          return send(response, 403, "Forbidden");
        }
        response.writeHead(200, {
          "cache-control": "no-store",
          connection: "keep-alive",
          "content-type": "text/event-stream",
          "x-content-type-options": "nosniff",
        });
        response.write(`event: state\ndata: ${JSON.stringify(this.#state())}\n\n`);
        for (const notification of this.#history) {
          response.write(sse(notification));
        }
        this.#listeners.add(response);
        request.once("close", () => this.#listeners.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === `${base}/status`) {
        return json(response, 200, this.#state());
      }
      if (request.method === "POST" && url.pathname === `${base}/input`) {
        if (!this.#validSession(request)) {
          return send(response, 403, "Forbidden");
        }
        const input = JSON.parse(await body(request)) as BrowserInput;
        const result = await this.#submit(input);
        return json(response, 202, result);
      }
      send(response, 404, "Not found");
    } catch (error) {
      json(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #submit(input: BrowserInput): Promise<{ turnId: string; steered: boolean }> {
    if (!this.#client || !this.#threadId) {
      throw new Error("Goal context is not connected.");
    }
    const hasText = typeof input.text === "string" && Boolean(input.text.trim());
    const hasImage = typeof input.image === "string" && Boolean(input.image);
    if (!hasText && !hasImage) throw new Error("A text message or image is required.");
    if (this.#activeTurnId && input.mode === "followup") {
      this.#followups.push(input);
      return { turnId: this.#activeTurnId, steered: false };
    }
    const values: CodexUserInput[] = [];
    const uploads: string[] = [];
    if (typeof input.text === "string" && input.text.trim()) {
      values.push({ type: "text", text: input.text.trim() });
    }
    if (typeof input.image === "string" && input.image) {
      const path = this.#saveImage(input.image, input.imageName);
      values.push({ type: "localImage", path });
      uploads.push(path);
    }
    if (this.#activeTurnId) {
      const clientMessageId = randomUUID();
      try {
        const turnId = await this.#client.steerTurn(
          this.#threadId, this.#activeTurnId, values, clientMessageId,
        );
        if (uploads.length > 0) {
          this.#turnUploads.set(turnId, [
            ...(this.#turnUploads.get(turnId) ?? []), ...uploads,
          ]);
        }
        return { turnId, steered: true };
      } catch (error) {
        for (const path of uploads) rmSync(path, { force: true });
        throw error;
      }
    }
    const submission = `browser-submit:${randomUUID()}`;
    if (!this.#store.tryClaimOperation(this.#options.contextId, submission)) {
      throw new Error("The goal context became busy; retry as a steering message.");
    }
    try {
      const turn = await this.#client.startTurn(
        this.#threadId,
        values,
        submission,
      );
      if (!this.#terminalTurns.has(turn.id)) this.#activeTurnId = turn.id;
      if (uploads.length > 0) {
        this.#turnUploads.set(turn.id, uploads);
      }
      if (this.#terminalTurns.has(turn.id)) {
        for (const path of uploads) rmSync(path, { force: true });
        this.#turnUploads.delete(turn.id);
        this.#store.finishOperation(this.#options.contextId, submission);
      } else {
        this.#store.replaceOperation(this.#options.contextId, submission, `turn:${turn.id}`);
      }
      return { turnId: turn.id, steered: false };
    } catch (error) {
      for (const path of uploads) {
        rmSync(path, { force: true });
      }
      this.#store.finishOperation(this.#options.contextId, submission);
      throw error;
    }
  }

  #saveImage(data: string, name: unknown): string {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match) {
      throw new Error("Image must be a base64 PNG, JPEG, WebP, or GIF data URL.");
    }
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
      throw new Error("Image must be between 1 byte and 10 MiB.");
    }
    void name;
    const extension = mimeExtension(match[1]);
    if (!validImageMagic(bytes, match[1])) {
      throw new Error("Image bytes do not match the declared image type.");
    }
    secureUploadDirectory(this.#options.uploadDirectory, !this.#uploadDirectoryReady);
    this.#uploadDirectoryReady = true;
    const path = join(this.#options.uploadDirectory, `${Date.now()}-${randomUUID()}${extension}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  }

  #state(): Record<string, unknown> {
    return {
      contextId: this.#options.contextId,
      threadId: this.#threadId,
      activeTurnId: this.#activeTurnId,
      connected: this.#client !== null,
    };
  }

  #validRequestHost(request: IncomingMessage): boolean {
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${this.#options.port}` && host !== `localhost:${this.#options.port}`) {
      return false;
    }
    const origin = request.headers.origin;
    return (
      !origin ||
      origin === `http://127.0.0.1:${this.#options.port}` ||
      origin === `http://localhost:${this.#options.port}`
    );
  }

  #validSession(request: IncomingMessage): boolean {
    return (request.headers.cookie ?? "")
      .split(";")
      .map((value) => value.trim())
      .includes(`after_party_context=${this.#session}`);
  }
}

function terminalHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>After Party goal context</title><style>
:root{color-scheme:dark}body{margin:0;background:#101418;color:#d8dee9;font:14px ui-monospace,monospace}
header{padding:10px 14px;border-bottom:1px solid #34404c;display:flex;gap:12px}.ok{color:#9ece6a}
#terminal{box-sizing:border-box;height:calc(100vh - 130px);overflow:auto;white-space:pre-wrap;padding:14px}
form{display:grid;grid-template-columns:1fr auto auto;gap:8px;padding:10px;border-top:1px solid #34404c}
textarea{min-height:52px;resize:vertical;background:#171e26;color:inherit;border:1px solid #45515e;padding:8px}
button,input{font:inherit}button{background:#7aa2f7;border:0;padding:0 18px;color:#101418}.hint{grid-column:1/-1;color:#8592a0}
</style></head><body><header><span>After Party goal context</span><span id="state">connecting</span></header>
<pre id="terminal"></pre><form id="form"><textarea id="text" placeholder="Message or steer this context"></textarea>
<select id="mode"><option value="steer">Steer active turn</option><option value="followup">Queue follow-up</option></select>
<button>Send</button><input id="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
<span class="hint">Choose whether an active message steers now or waits as the next turn. Paste or choose an image.</span></form>
<script src="./client.js"></script></body></html>`;
}

function terminalClient(): string {
  return `const base=location.pathname.replace(/\\/$/,''), terminal=document.querySelector('#terminal'), state=document.querySelector('#state');
const text=document.querySelector('#text'), image=document.querySelector('#image'), mode=document.querySelector('#mode'); let pasted=null;
function append(v){terminal.textContent+=v+'\n';terminal.scrollTop=terminal.scrollHeight}
const events=new EventSource(base+'/events');
events.addEventListener('state',e=>{const v=JSON.parse(e.data);state.textContent=v.activeTurnId?'active':'connected';state.className='ok'});
events.onmessage=e=>{const v=JSON.parse(e.data),p=v.params||{};
 if(v.method==='conversation/snapshot'){terminal.textContent='';for(const x of p.entries||[])append((x.role?x.role+': ':'')+(x.text||''));return}
 if(v.method==='conversation/delta'){terminal.textContent+=p.text||'';terminal.scrollTop=terminal.scrollHeight;return}
 if(v.method==='conversation/message'){append((p.role?p.role+': ':'')+(p.text||''));return}
 if(v.method==='conversation/tool'){append('$ '+(p.text||''));return}
 if(v.method==='conversation/error')append('error: '+(p.message||'unknown error'))};
events.onerror=()=>{state.textContent='reconnecting';state.className=''};
text.addEventListener('paste',e=>{for(const item of e.clipboardData.items){if(item.type.startsWith('image/')){pasted=item.getAsFile();image.value='';e.preventDefault();break}}});
text.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.querySelector('#form').requestSubmit()}});
document.querySelector('#form').addEventListener('submit',async e=>{e.preventDefault();const file=pasted||image.files[0];let encoded;
 if(file) encoded=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)});
 const response=await fetch(base+'/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:text.value,image:encoded,imageName:file&&file.name,mode:mode.value})});
 const result=await response.json();if(!response.ok){append('error '+result.error);return}append(result.steered?'[steered]':(mode.value==='followup'?'[follow-up queued]':'[submitted]'));text.value='';image.value='';pasted=null});
`;
}

function renderNotification(
  notification: CodexAppServerNotification,
): CodexAppServerNotification | null {
  const params = notification.params ?? {};
  if (notification.method === "item/agentMessage/delta" && typeof params.delta === "string") {
    return { method: "conversation/delta", params: { text: params.delta } };
  }
  if (notification.method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
    return { method: "conversation/tool", params: { text: params.delta } };
  }
  if (notification.method === "item/completed") {
    const item = objectValue(params.item);
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return { method: "conversation/message", params: { role: "assistant", text: item.text } };
    }
    if (item?.type === "commandExecution") {
      const command = typeof item.command === "string" ? item.command : "command";
      return { method: "conversation/tool", params: { text: command } };
    }
  }
  if (notification.method === "after-party/server-request-rejected") {
    return { method: "conversation/error", params: { message: `Unsupported request: ${String(params.requestMethod)}` } };
  }
  return null;
}

function snapshotEntries(snapshot: Record<string, unknown>): Array<{ role: string; text: string }> {
  const entries: Array<{ role: string; text: string }> = [];
  for (const turnValue of Array.isArray(snapshot.turns) ? snapshot.turns : []) {
    const turn = objectValue(turnValue);
    for (const itemValue of Array.isArray(turn?.items) ? turn.items : []) {
      const item = objectValue(itemValue);
      if (item?.type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        entries.push({ role: "user", text: content.map((part) => {
          const value = objectValue(part);
          return value?.type === "text" && typeof value.text === "string" ? value.text : "[image]";
        }).join("\n") });
      } else if (item?.type === "agentMessage" && typeof item.text === "string") {
        entries.push({ role: "assistant", text: item.text });
      } else if (item?.type === "commandExecution" && typeof item.command === "string") {
        entries.push({ role: "tool", text: `$ ${item.command}` });
      }
    }
  }
  return entries;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function secureUploadDirectory(path: string, clean: boolean): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
    throw new Error("Upload directory must be an owned, real directory.");
  }
  chmodSync(path, 0o700);
  if (clean) {
    for (const name of readdirSync(path)) {
      rmSync(join(path, name), { recursive: true, force: true });
    }
  }
}

function notificationTurnId(notification: CodexAppServerNotification): string | null {
  const params = notification.params;
  if (typeof params?.turnId === "string") {
    return params.turnId;
  }
  const turn = params?.turn;
  return turn && typeof turn === "object" && !Array.isArray(turn) && "id" in turn &&
    typeof turn.id === "string" ? turn.id : null;
}

function sse(notification: CodexAppServerNotification): string {
  return `data: ${JSON.stringify(notification)}\n\n`;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function send(
  response: ServerResponse,
  status: number,
  value: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'none'; style-src 'unsafe-inline'; script-src 'self'",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(value);
}

function mimeExtension(mime: string): string {
  return mime === "image/jpeg" ? ".jpg" : `.${mime.slice("image/".length)}`;
}

function validImageMagic(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mime === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  if (mime === "image/gif") {
    return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  }
  return (
    mime === "image/webp" &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function activeTurnFromSnapshot(snapshot: Record<string, unknown>): string | null {
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (
      turn &&
      typeof turn === "object" &&
      !Array.isArray(turn) &&
      turn.status === "inProgress" &&
      typeof turn.id === "string"
    ) {
      return turn.id;
    }
  }
  return null;
}

function snapshotHasActivity(snapshot: Record<string, unknown>): boolean {
  return Array.isArray(snapshot.turns) && snapshot.turns.length > 0;
}
