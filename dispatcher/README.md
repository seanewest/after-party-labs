# Persistent goal-context dispatcher

This document defines the target contract being implemented by Goal #34. The checked-in dispatcher
still exposes the earlier named-worker queue, runner, hooks, and GitHub poller; it does **not** yet
implement the `party goal` commands or browser-visible goal context described below. Those old
commands are compatibility inputs, not an active ownership or PR-handoff workflow.

The completed dispatcher turns each actionable GitHub goal into one durable, browser-visible Codex
context. The context owns its goal through implementation, testing, temporary-subagent review,
fixes, merge, deployment, and acceptance proof. GitHub is authoritative for durable intent and
evidence; local state provides execution, recovery, and the live conversation surface.

## Interaction contract

In the target behavior, an eligible goal in **Ready** is assigned exactly one stable Goal Context
ID. The dispatcher records that ID and a clickable loopback Context URL on the card, starts the
context, and moves the goal to **In Progress**. The URL opens the same conversation and execution
surface used for automated turns. It shows a running turn incrementally and supports ordinary
prompts, steering, image paste, detach, and reattach.

Context identity belongs to the goal, not to a persona, terminal, tmux session, process, worktree,
branch, or port. Those resources may be recreated. A restart must recover the goal-context mapping,
conversation identity, branch and worktree association, pending events, and safe next action from
durable state.

The board flow is **Backlog**, **Ready**, **In Progress**, **Human Needed**, and **Done**. Review,
check waits, event sleeps, merge, deployment, and proof remain In Progress. Human Needed is reserved
for a real decision, unavailable external authority, an unauthorized consequential action, or
subjective acceptance.

## One owner, bounded subagents

The goal context keeps its evolving technical plan internally. It may create temporary subagents
for bounded research or adversarial review, then incorporates their findings itself. Subagents do
not claim board cards, become persistent workers, or create pull-request handoffs. Material review
conclusions belong on the pull request.

The dispatcher uses deterministic routing. It does not use an LLM to choose owners or recreate an
implementation/reviewer hierarchy. Retired board fields and signed persona comments are ignored for
dispatch.

## Events and delivery

Changes to the goal, linked pull request, review comments, checks, merge, deployment, and human
responses become durable events for the same context. Each source event has a stable ID and source
ordering key. The dispatcher records source progress and event insertion durably before advancing
its per-source checkpoint, so restart and pagination cannot silently skip work. A goal-level queue
uses recorded source time plus a deterministic tie-breaker. Before applying an event, its handler
compares the event's source version and current GitHub state. Stale or superseded events are
recorded as consumed without regressing state or repeating an action.

Delivery is at least once internally. A stable event ID survives retries, and the recipient records
a durable receipt. Action-level idempotency prevents a repeated observation from creating another
context, prompt, comment, merge, or deployment. A crash after observable work but before a final
outcome is recorded is treated as ambiguous and recovered deliberately rather than replayed
blindly.

Busy contexts retain events in source order. Idle or sleeping contexts resume automatically.
Waiting for a check, review, deployment, or other machine-observable event ends the current model
turn; durable state wakes the same context later. Automated delivery must coordinate with the
browser terminal so that only one Codex client owns the conversation at a time.

## Local-only browser boundary

Context URLs use a loopback host and contain no reusable secret. The local dispatcher resolves a
stable URL to the context's current process and port. It must reject non-loopback exposure and must
not make credentials, transcripts, or control tokens available through GitHub.

The shared app-server/remote-TUI path is the intended surface: the server remains independent of a
particular terminal attachment, while browser connections may come and go without ending the
conversation. Pasted images and steering messages travel through that same context.

## State and recovery

Machine state lives under `${XDG_STATE_HOME:-~/.local/state}/after-party/` unless explicitly
overridden. Databases, credentials, transcripts, locks, and machine-specific paths never enter Git.
Durable state includes at least:

- the repository and goal number;
- Goal Context ID and Codex conversation/session identity;
- worktree, branch, and pull-request association;
- current lifecycle state and loopback route;
- ordered pending events, receipts, attempts, and outcomes; and
- source checkpoints and recovery diagnostics.

Startup reconciles durable records with actual processes, worktrees, sessions, and ports. Before a
context sleeps or stops normally, it records its current head, dirty-worktree state, and pending
operation; recover refuses to discard or overwrite an existing dirty worktree. A missing worktree
may be recreated from the recorded branch and head only when the last checkpoint was clean.
Otherwise recovery reports the missing local state explicitly instead of claiming the work was
reconstructed. Stale locks and routes are repaired only after ownership is proven absent.
Overlapping poll or runner processes serialize claims in SQLite transactions.

## Operator interface

The goal-context implementation must expose these operations without requiring a permanent worker
terminal:

```text
party goal start OWNER/REPO#NUMBER
party goal stop OWNER/REPO#NUMBER
party goal status [OWNER/REPO#NUMBER]
party goal recover OWNER/REPO#NUMBER
party goal open OWNER/REPO#NUMBER
party goal logs OWNER/REPO#NUMBER
party goal inspect OWNER/REPO#NUMBER
party run [--once]
```

`start` is idempotent and returns the existing context when one is already assigned. `stop` ends
ephemeral execution without deleting durable context state. `recover` reconciles and resumes the
same context. `open` resolves or launches the safe loopback browser route. `status` is concise;
`inspect` includes pending events and recovery state; `logs` streams sanitized local diagnostics.
`run --once` performs one bounded reconciliation and event-delivery pass for schedulers and tests.

These commands define the target interface for the migration. Until the implementation lands, the
existing `party` queue, hook, and GitHub polling commands are compatibility plumbing and must not be
used to assign goals by permanent worker name.

For the first usable cutover, the maintainer may explicitly start one local `party run` process or
scheduler. That runner observes Ready goals and creates their routes; it is not a separate goal
owner, and no per-goal worker terminal is required. `party run --once` performs the same bounded
reconciliation for tests or an external scheduler. Completing Goal #34 requires installing the
runner as a restartable local user service so Ready cards and later events resume contexts without
that manual bootstrap terminal.

## Lifecycle trust boundary

Codex lifecycle integration must be installed from a reviewed primary checkout and explicitly
trusted by the local operator. The dispatcher never bypasses hook trust or raises an unattended
approval prompt. Hook installation updates only configuration it can prove it owns and fails
visibly when definitions are missing, changed, disabled, or untrusted.

Hooks report session and prompt boundaries; structured Codex/app-server events report turn success
or failure. Terminal text and tmux panes are not scraped to infer outcomes.

## Validation

Use `npm run check:types` and `npm run test:dispatcher` for offline validation. Real acceptance must
start from a GitHub goal, expose a live loopback context, demonstrate steering and image paste,
survive detach plus process or WSL-style reconstruction, resume from at least one durable external
event, finish a real change through temporary-subagent adversarial review and fixes, merge it, and
record proof without human message shuttling.
