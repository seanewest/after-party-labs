# Shared goal-context surface evidence

The persistent goal-context dispatcher uses one long-lived Codex app-server thread per GitHub goal.
Automation and the local browser gateway are clients of that thread, so they share one conversation
and one execution surface instead of independently resuming it.

This design was selected after a real installed-Codex prototype compared tmux-only prompt injection
with a shared app-server. Tmux injection preserved visibility but could not provide structured prompt
receipt or terminal outcome without scraping terminal text. The app-server provides `turn/start`,
`turn/steer`, incremental item notifications, and `turn/completed` while remote clients observe the
same thread.

## Proven behavior

The authenticated prototype against Codex CLI 0.144.6 demonstrated that an app-server-started turn:

- appeared incrementally in a remote Codex TUI while active;
- accepted steering that changed the in-flight result;
- survived observer detach and reattach on the same thread;
- produced structured receipt and completion without pane scraping;
- allowed ordinary chat after completion;
- accepted a local image through the same remote surface; and
- excluded a competing thread owner through the existing OS lock.

PR #68 contains the original prototype and real-smoke evidence. Goal #34 integrates its app-server
client and tests, replacing its former persona-specific registry with a durable Goal Context ID.

## Production boundary

The app-server is a separately supervised local process. The browser gateway is disposable: after
restart it reconnects to the persisted endpoint, resumes the persisted thread, reconstructs the
active turn from the returned thread snapshot, and continues to stream notifications. It never
silently creates a new thread when resume fails.

The browser gateway binds to loopback, validates Host and Origin, sets a same-site context cookie,
and exposes only allowlisted operations for its configured thread. The browser never receives the
raw app-server WebSocket. Image bytes are size- and signature-checked, written under mode-0700 local
state with random names and mode 0600, and passed to Codex as `localImage` input. The URL stored on
GitHub contains no reusable secret.

App-server requests for approval, tool input, token refresh, or other authority are rejected
explicitly when the gateway cannot safely handle them; they are not ignored or approved. Only
`turn/completed` is terminal. A lost stream after turn acceptance is ambiguous and is never replayed
automatically.

## Validation

Run offline coverage with:

```text
npm run check:types
npm run test:dispatcher
```

Run the opt-in authenticated shared-surface proof with:

```text
npm run test:dispatcher:shared-real
```

The real smoke makes model calls and is not part of ordinary CI. Goal #34 acceptance additionally
requires a browser-visible run, event-driven resume, process reconstruction, merge, and durable
proof from a real GitHub goal.
