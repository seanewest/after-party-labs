# Dispatcher and named workers

This directory contains the local, durable handoff queue from Task #35, the named Codex worker
runner from Task #36, and the GitHub feedback and continuation adapters from Tasks #37 and #57.

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
claims. One Codex client owns a worker session at a time: an attached interactive TUI makes queued
delivery wait, while a detached idle TUI is stopped before structured delivery begins. During that
turn, `party agent NAME` refuses to start a competing TUI. Attaching after delivery resumes the saved
session, including the queued turn, in the normal interactive interface.

`party agent`, `party deliver`, and `party run` serialize that ownership with the same per-worker
filesystem lock next to the dispatcher database. The lock is held for the complete interactive
attachment or until the structured Codex child has fully exited; queue availability and tmux client
checks are status signals, not the ownership primitive. A crashed owner releases the OS lock when
its file descriptors close, and the next runner reconciles stale automated status. This WSL runner
requires the standard `flock` command.

Machine-specific worktree paths, Codex session IDs, and activity state live in
`${XDG_STATE_HOME:-~/.local/state}/after-party/dispatcher.sqlite`, never in Git.
Party adds only the directory containing that active database as an additional Codex writable
directory. This keeps the normal worktree sandbox in place while allowing a named worker to create
an outbound handoff with `party-dispatcher enqueue`; it does not grant access to the rest of the
home directory, Git metadata, `.codex`, or the network.

## Lifecycle hook boundary

The reviewed hook implementation is `hooks/lifecycle.ts`. After updating the primary checkout to a
reviewed commit, install its definition once at the user level:

    npm run party -- hooks install

Then open `/hooks` in Codex and trust the `SessionStart`, `UserPromptSubmit`, and `Stop` definitions.
Use `npm run party -- hooks status` to inspect the installation or
`npm run party -- hooks uninstall` to remove it. Codex requires a fresh trust review whenever an
installed definition changes, and the dispatcher never uses `--dangerously-bypass-hook-trust`.

The installer writes `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) with an absolute command
pointing to the primary checkout. That makes the same reviewed handler available to every linked
worktree even when a worker remains on an older or unrelated feature branch. The handler returns
without changing dispatcher state outside configured named-worker worktrees, using a read-only
lookup before it opens the dispatcher state for writing. To avoid running the same event twice, the
repository does not also install project-local hooks. The installer updates or removes only a file
it recognizes as After Party-managed and refuses to overwrite or remove any other personal hook
configuration.

The trusted `SessionStart`, `UserPromptSubmit`, and `Stop` events register the named session and set
idle/busy state without scraping terminal output. A dispatcher prompt includes an
`AFTER_PARTY_HANDOFF_V1` envelope. `UserPromptSubmit` validates the complete envelope against the
queue and records its durable receipt before processing. A retained receipt blocks duplicates but
does not block a new attempt explicitly authorized by a `retry_safe` interruption. `Stop` only
records lifecycle state; it never infers successful model work.

Normal `party deliver` and `party run` handoffs become the worker's sole Codex client, resume the
worker through `codex exec --json`, and feed that complete event stream directly to
`StructuredTurnOutcomeMonitor`. If the worker has no saved session yet, the runner starts a new
structured Codex session in its configured worktree.
This path inherits the user's normal Codex configuration and does not bypass sandbox, approval, or
hook trust. `party agent NAME` remains the interactive tmux/TUI path for direct human prompts,
screenshot paste, and steering; automation waits while that TUI is attached.

For diagnostics, structured Codex JSONL can also be consumed manually from stdin with:

    npm run party -- turn-events MESSAGE_ID --reported-by beavis \
      --attempt 1 --stream-id SESSION_OR_STREAM_ID < codex-events.jsonl

The adapter understands `codex exec --json` events such as `turn.completed`, `turn.failed`,
`item.*`, and `error`, plus app-server `item/*`, `error`, and `turn/completed` notifications. Only a
structured completion completes the queue message. A transient error may retry only when the event
history proves no model output or tool activity began; partial, post-work, and unclassified
failures take the durable escalation path. The production queue runner does not require a separate
manual event command. The tmux adapter never scrapes its pane or treats a `Stop` hook as a provider
outcome.

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
- A GitHub continuation registration records one expected pull-request head and transition, then
  uses the same queue and worker-state behavior when that transition occurs.
- Either adapter calls `createEscalation`; Morpheus inspects and resolves the durable record.
- Both adapters may create separate `DispatcherQueue` instances against the same SQLite file;
  `BEGIN IMMEDIATE` transactions and conditional state changes serialize competing consumers.

The default database is `${XDG_STATE_HOME:-~/.local/state}/after-party/dispatcher.sqlite`. Set
`PARTY_DISPATCHER_DB` or pass `--database` to use an isolated location.

Run `npm run party -- help` for worker commands, `npm run party:queue -- help` for direct queue
inspection, `npm run check:types` for static checks, and `npm run test:dispatcher` for the offline
suite. `npm run test:dispatcher:real` is an explicit local smoke using the installed authenticated
Codex CLI; it makes real model calls to verify TUI delivery, sole-client automated resume, and later
interactive steering, so normal CI does not run it.

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

## GitHub transition continuations

An agent whose next action is blocked only on a pull request merge or check completion can register
a durable one-shot wait and end its turn:

    party-dispatcher continuation-register \
      --repository seanewest/after-party-labs --pull-request 456 \
      --expected-head FULL_HEAD_SHA --event pull_request_merged \
      --from beavis --to beavis --task 123 \
      --message "Re-read Task #123 and merged PR #456, then continue."

The supported events are `pull_request_merged` and `checks_completed`. Check completion means at
least one check is reported and every reported check has reached a terminal state; failure is still
a completion event so the responsible agent can interpret it. Registrations are idempotent for the
same repository, pull request, expected head, event, recipient, and Task. Conflicting instructions
for the same logical registration are rejected instead of silently replacing durable state.

Each scheduled `poll:github` pass groups pending registrations by pull request and reads the current
head, merge state, and check rollup with the authenticated `gh` CLI. The expected head must match.
Merge waits fail if the pull request closes unmerged, and check waits fail if it closes before the
checks finish. A successful transition enqueues one message with a continuation-ID deduplication
key. This closes the crash window between queue insertion and marking the registration complete and
makes restarts and overlapping pollers safe.

Busy and sleeping recipients keep the queued message. An unavailable recipient produces a durable
`worker_unavailable` escalation; source read errors remain pending and produce a deduplicated
`delivery_failure` escalation; stale heads and closed-unmerged outcomes become failed registrations
with durable escalation evidence for Morpheus. Inspect them with:

    party-dispatcher continuations [--outcome pending|queued|failed]
    party-dispatcher inspect-continuation CONTINUATION_ID
