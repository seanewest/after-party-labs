# Dispatcher and named workers

This directory contains the local, durable handoff queue from Task #35, the named Codex worker
runner from Task #36, and the GitHub feedback adapter from Task #37.

## Named Codex workers

Configure each worker once with an absolute Git worktree path kept in the local state database:

    npm run party -- configure beavis /absolute/path/to/beavis
    npm run party -- configure cornholio /absolute/path/to/cornholio

Then `npm run party -- agent beavis` opens the normal interactive Codex TUI. The command hides tmux:
an existing tmux session attaches, while a missing session starts Codex in the configured worktree
and resumes its saved Codex session when one is known. Detaching or closing the outer terminal does
not destroy a running worker, and the attached TUI still accepts normal human prompts, screenshots,
and steering.

`npm run party -- deliver` processes one ready handoff. `npm run party -- run` keeps processing, and
`npm run party -- run --once` provides a one-cycle automation check. Busy workers are excluded from
claims; workers without a tmux session are marked asleep and woken before delivery.

Machine-specific worktree paths, Codex session IDs, and activity state live in
`${XDG_STATE_HOME:-~/.local/state}/after-party/dispatcher.sqlite`, never in Git.

## Lifecycle hook boundary

The reviewed hook implementation is `hooks/lifecycle.ts`; `hooks/hooks.json` is a non-active
installation template. Task #38 owns copying or linking that definition into a supported Codex hook
location and completing the required trust review. Task #36 does not bypass or pre-approve hook
trust.

The trusted `SessionStart`, `UserPromptSubmit`, and `Stop` events register the named session and set
idle/busy state without scraping terminal output. A dispatcher prompt includes an
`AFTER_PARTY_HANDOFF_V1` envelope. `UserPromptSubmit` validates the complete envelope against the
queue and records its durable receipt before processing. A retained receipt blocks duplicates but
does not block a new attempt explicitly authorized by a `retry_safe` interruption. `Stop` only
records lifecycle state; it never infers successful model work.

Structured Codex JSONL events are consumed by `StructuredTurnOutcomeMonitor`, or from stdin with:

    npm run party -- turn-events MESSAGE_ID --reported-by beavis \
      --attempt 1 --stream-id SESSION_OR_STREAM_ID < codex-events.jsonl

The adapter understands `codex exec --json` events such as `turn.completed`, `turn.failed`,
`item.*`, and `error`, plus app-server `item/*`, `error`, and `turn/completed` notifications. Only a
structured completion completes the queue message. A transient error may retry only when the event
history proves no model output or tool activity began; partial, post-work, and unclassified
failures take the durable escalation path. The tmux adapter never scrapes its pane or treats a
`Stop` hook as a provider outcome.

## Delivery contract

Delivery is **at least once**. Each envelope keeps one stable message ID across attempts. A runner
claims a lease, marks delivery as started, and the recipient records a durable receipt keyed by the
message ID. Once that receipt exists, lease expiry alone will not make a restarted queue claim the
message again.

There is an unavoidable crash window after an external recipient accepts a prompt but before the
receipt becomes durable. The queue retries the same message ID after the lease expires; it does not
claim exactly-once prompt delivery.

The normal state sequence is:

    queued -> leased -> delivering -> receipted -> acknowledged -> completed

Delivery errors move an in-flight message to `failed`; an explicit retry returns it to `queued`.
Expired `leased` or `delivering` messages return to `queued` automatically. Only `queued` and
`failed` messages can be cancelled before a receipt arrives.

Prompt receipt and successful model work are separate facts. After receipt, a runner reports a
structured turn failure with `reportTurnInterruption` or the `turn-interrupted` CLI command:

- A transient failure with evidence that no model output or tool activity began may return the same
  recognizable message ID to `queued` after a delay of at most five minutes. The original receipt
  and an interruption record remain durable for audit.
- A failure after observable work, or one whose progress is unknown, moves the message to `failed`
  and creates one deduplicated `delivery_failure` escalation for Morpheus. It is never replayed
  automatically because doing so could duplicate work or side effects.

A capacity or provider interruption is not permanent worker unavailability. Task #36's session
runner must prefer structured `turn.failed`, `turn.completed`, and error events when the Codex
surface exposes them. Lifecycle hooks may record session and prompt boundaries, but the runner must
not classify terminal text by screen scraping. If the available surface cannot prove that no work
started, it takes the ambiguous escalation path.

## Worker and escalation boundary

The same database holds one durable availability record for each named worker. The core recognizes
`unknown`, `idle`, `busy`, `asleep`, and `unavailable`; it ignores stale observations. Claims can be
restricted atomically to selected states, so the runner leases only idle or sleeping workers.

Escalations are durable, deduplicated records for worker unavailability, ambiguous ownership,
repeated review cycles, delivery failures, or a manual intervention. They remain assigned
conceptually to Morpheus without silently changing a Task's `Original Agent`. Task #37 may create
them when GitHub routing cannot safely choose a recipient, while Task #36 may create them when a
worker is genuinely unavailable.

## Extension points

- The session runner calls `claimNext`, `beginDelivery`, and `acknowledge`; the recipient hook calls
  `recordReceipt`, making receipt persistence independent from the injecting process.
- A structured turn outcome source calls `complete` after success or `reportTurnInterruption` after
  failure; lifecycle hooks call `setWorkerAvailability` without classifying provider errors.
- The GitHub poller records source events and advances each source checkpoint in one SQLite
  transaction, then calls `enqueue` with a durable `dedupeKey` derived from the GitHub event ID.
- Either adapter calls `createEscalation`; Morpheus inspects and resolves the durable record.
- Both adapters may create separate `DispatcherQueue` instances against the same SQLite file;
  `BEGIN IMMEDIATE` transactions and conditional state changes serialize competing consumers.

The default database is `${XDG_STATE_HOME:-~/.local/state}/after-party/dispatcher.sqlite`. Set
`PARTY_DISPATCHER_DB` or pass `--database` to use an isolated location.

Run `npm run party -- help` for worker commands, `npm run party:queue -- help` for direct queue
inspection, `npm run check:types` for static checks, and `npm run test:dispatcher` for the offline
suite plus an auto-skipped local Codex/tmux smoke test when those tools are unavailable.

## GitHub feedback polling

`npm run poll:github -- --owner seanewest --project 1` runs one bounded polling pass using the
locally authenticated `gh` CLI. An external scheduler may invoke the same command again; the
poller itself does not become a persistent service.

Only active board Tasks in **In Progress** or **Review** and their linked pull requests are in
scope. The poller follows pages for review submissions, inline review comments, and pull-request
conversation comments. It records every valid source event before advancing that source's durable
checkpoint. Queue insertion uses the stable GitHub source ID as its deduplication key, so a crash
between enqueueing and marking the event routed is safe to retry.

Actionable signed feedback returns to the Task's sticky `Original Agent`; the mutable `Current Agent`
does not affect routing. The poller ignores the implementer's own
comments, approvals, and informational updates. A signed conversation comment is actionable when
it explicitly names the implementer or uses clear change-request language; inline review comments
and signed changes-requested reviews are actionable directly. Busy and sleeping workers retain
their queued work. Missing or ambiguous board ownership, unavailable workers, source failures, and
three changes-requested review cycles create durable Morpheus escalations without changing the
board's `Original Agent` field.
