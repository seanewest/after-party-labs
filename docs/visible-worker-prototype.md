# Visible worker prototype

Task #63 evaluates how one named worker can keep one visible, steerable conversation while the
dispatcher submits work and receives structured outcomes. The prototype result is to use **one
long-lived Codex app-server per worker**, with both the dispatcher and the normal Codex TUI acting
as clients of that server and thread.

This is a bounded proof, not the Task #64 production migration. Normal `party agent`, `party
deliver`, and `party run` keep their reviewed v1 behavior unless the explicit prototype commands
below are used.

## Why the app-server path wins

The installed Codex CLI was `0.144.6` when this proof was run on 2026-07-20.

| Requirement | Sole tmux TUI injection | Shared app-server thread |
| --- | --- | --- |
| Dispatcher prompt is visible while it runs | Yes | Yes |
| Human can steer and queue in the normal TUI | Yes | Yes |
| Detach and reattach preserve the turn | Yes | Yes |
| Normal TUI accepts image input | Yes | Yes |
| Dispatcher receives a structured prompt receipt | No | `turn/start` response |
| Dispatcher receives structured terminal status | No | `turn/completed` notification |
| No terminal screen scraping | Cannot satisfy | Satisfies |

Tmux injection alone therefore cannot meet the queue contract. Codex lifecycle hooks can prove
that a prompt crossed a hook boundary, but `Stop` does not distinguish completion, provider
failure, or interruption. Getting that distinction from a sole TUI would require parsing terminal
text, which the dispatcher explicitly forbids.

The app-server owns the Codex thread once. The dispatcher calls `turn/start` and optionally
`turn/steer`; any number of remote TUI connections observe and control that same in-memory thread.
Those are multiple clients of one owner, not competing Codex processes independently resuming the
same rollout.

## What was proved

The real installed-CLI probe and opt-in smoke cover this sequence:

1. Start `codex app-server` on a loopback WebSocket and create or resume one durable thread.
2. Start a turn through JSON-RPC and receive its turn ID from the structured `turn/start` response.
3. Attach the normal TUI with `codex resume THREAD --remote ENDPOINT` while the turn is active.
4. Observe incremental assistant and tool activity in that TUI without using the pane as outcome
   evidence.
5. Press Enter with a follow-up while work is active; the TUI steers that same turn. Press Tab when
   the intent is to queue a later turn.
6. Disconnect one observer, connect another to the same thread, and retain the visible transcript
   and active work.
7. Receive `turn/completed` over JSON-RPC and feed it to the existing
   `StructuredTurnOutcomeMonitor`, which completes or interrupts the durable queue message.
8. Continue ordinary chat in the same remote TUI after the dispatched turn. The remote resume
   command also retains the normal `-i/--image` input path for screenshots.

Pane capture is used only by the opt-in smoke to assert that a human-visible marker appeared. Queue
receipt, completion, failure, and interruption are derived exclusively from app-server messages.

Run the offline adapter tests with:

    npm run test:dispatcher

Run the authenticated installed-Codex proof explicitly with:

    npm run test:dispatcher:shared-real

The real smoke makes model calls and is never part of ordinary CI.

## Manual prototype

Start one local server in a dedicated terminal. This command holds the existing worker-owner lock
for the server's entire lifetime, so a second server or the v1 `codex exec resume` owner fails
closed. Loopback is intentional; do not expose the experimental unauthenticated endpoint to the
network.

    npm run party -- shared-server daria --listen ws://127.0.0.1:4500

After that server has loaded the worker's saved thread, attach the worker's normal TUI without
taking the v1 exclusive client lock:

    npm run party -- agent daria --remote ws://127.0.0.1:4500

Process one queued message for only that worker through the prototype adapter:

    npm run party -- shared-deliver daria --remote ws://127.0.0.1:4500

`shared-deliver` preserves the existing queue envelope, receipt, acknowledgement, structured
outcome, retry, and escalation policies. It does not stop the remote TUI. A successful `turn/start`
response is persisted as the receipt, and `turn/completed` remains the only success boundary.

Keep `shared-server` running whenever either prototype client is used. Remote TUI and dispatcher
connections intentionally do not take its exclusive owner lock: they are clients of the already
locked server. Commands that bypass `party` can also bypass this protection and are unsupported.

Do not point these commands at a worker whose existing tmux pane was started without `--remote`.
The prototype does not yet persist or reconcile the pane's endpoint, and `TmuxWorkerTerminal`
correctly leaves an existing pane alone.

## Installed-Codex limitations

- App-server and its WebSocket transport are experimental, and generated request/notification
  schemas are version-specific. The adapter uses only `initialize`, `thread/resume`, `turn/start`,
  `turn/steer`, and `turn/completed` from Codex `0.144.6`.
- The prototype does not supervise server startup, health, restart, socket cleanup, or version
  compatibility. An app-server loss after receipt is treated as ambiguous post-work failure and
  escalated; it is never replayed automatically.
- Endpoint and process ownership are not yet stored in the worker registry. A second app-server or
  a direct `codex exec resume` against the same thread must be treated as a competing owner, even
  though several app-server and TUI clients are safe.
- Approval routing, hook trust, permissions, and client reconnection need real-worker coverage
  during migration. The prototype does not bypass any of them.
- The app-server notification stream contains events unrelated to queue outcomes. Only the
  reviewed turn monitor classifies terminal success or failure.
- Loopback WebSockets work for the proof. A local Unix socket is preferable for the durable WSL
  runner if the installed remote TUI and Node WebSocket client are both verified against it.

## Bounded Task #64 migration

Task #64 should change only the named-worker ownership layer:

1. Supervise exactly one app-server per configured worker and persist endpoint, PID/health,
   Codex version, thread ID, and launch generation in machine-local state.
2. Make `party agent NAME` always open a remote TUI for that server, so attach, detach, reattach,
   steering, queued follow-ups, and images remain ordinary TUI operations.
3. Replace the `codex exec resume --json` delivery source with this shared app-server adapter while
   retaining the existing queue, receipt, interruption, lock, hook, and GitHub routing contracts.
4. Move exclusive locking to app-server ownership and migration/recovery. Dispatcher and TUI
   client connections must coexist; direct alternate owners must fail closed.
5. Reconcile server death and stale endpoints before claiming work. Never infer completion from a
   disconnected client or a terminal pane.
6. Add a five-worker cutover test matrix covering active attach, detach/reattach, TUI steer, queued
   follow-up, local image input, post-completion chat, structured failures, restart recovery, and
   rejection of a competing owner.

The dashboard, GitHub poller, board workflow, and all five workers should remain outside Task #63.
