# Proposed dispatcher v2: task-bound Codex contexts

## Status

**Proposal only. This design is not adopted and does not change the current workflow.**

Dispatcher v1 remains the active design: Beavis, Butthead, Cornholio, Daria, and Morpheus are
durable worker names, and the board's `Original Agent` and `Current Agent` fields route work among
them. The current dispatcher Tasks should be completed and exercised before this proposal becomes
an implementation Story. Agents must not apply this document to current board work unless the
human explicitly adopts v2.

## Motivation

Named workers currently serve two practical purposes:

1. preserve the context that produced a Task's first implementation pull request; and
2. identify the worker that owns the next implementation, review, or rework action.

Those needs do not inherently require permanent personas. A future dispatcher could attach the
durable identity to the Task and its Codex contexts while creating and removing worker processes and
tmux sessions on demand.

This may simplify the human model: open a Task, see what action is happening, and enter either the
current working context or the original implementation context without first finding a named
worker.

## Proposed model

Each Task would have two context references:

- **Implementation context** is the Codex thread that created the first implementation pull
  request. It is sticky for the life of the Task and is the normal destination for requested
  implementation changes.
- **Current context** is the Codex thread that owns the next action now. It changes across
  implementation, review, rework, and re-review, and is blank while waiting for a human or after
  completion.

The dispatcher would also record the current action, such as `implement`, `review`, `rework`, or
`re-review`. Contexts may use functional labels such as `task-39-implementation` and
`task-39-review-1`; they do not need permanent character names.

The issue, pull request, review comments, tests, and project status remain the durable public record.
Private Codex context is an efficiency aid, not required evidence. A fresh context must still be
able to take over when a saved context is missing, unavailable, or no longer effective.

## Browser terminal and runtime lifecycle

The dispatcher could expose stable private routes such as:

- `/tasks/39/current` for the context working on the Task now; and
- `/tasks/39/implementation` for the context that created its first pull request.

A route would resolve through the dispatcher rather than exposing a tmux name or Codex thread ID.
It would open a browser terminal, connect through a WebSocket to a pseudoterminal, and attach to the
appropriate tmux session. The browser terminal would display the normal Codex CLI; this is not a
custom Codex chat interface and does not involve chatgpt.com or the ChatGPT app.

tmux would be temporary runtime state, not the durable context store. When no live session exists,
the dispatcher would create one and resume the recorded Codex thread. An idle terminal could be
removed without losing the mapping needed to restore it later.

Text copy and paste should use normal browser-terminal behavior. Screenshot paste would require a
small gateway extension that accepts the clipboard image, stores it in a controlled temporary
location, and makes it available to the resumed Codex context.

## Example lifecycle

1. A Ready Task is claimed. The dispatcher creates an implementation context and tmux session.
2. That context opens the first pull request and becomes the Task's sticky Implementation context.
3. The Task enters Review. The dispatcher creates an independent review context and makes it the
   Current context.
4. If changes are requested, the dispatcher restores the Implementation context and makes it
   Current for rework.
5. Re-review may restore the previous review context or create a new independent one.
6. When the Task is Done, its tmux sessions may be removed. Context metadata is retained according
   to an explicit retention policy.

Morpheus could remain a human-facing name for the coordinator, escalation queue, or web gateway. It
would not need to be a permanent reasoning worker through which every message passes.

## Why this is deferred

Dispatcher v1 is substantially implemented and provides the shortest path to a system that can be
used and evaluated. Replacing its named registry now would delay the first end-to-end experience
and discard useful operational learning.

The recommended sequence is:

1. finish and validate the named-worker dispatcher v1;
2. use it long enough to identify real lifecycle and routing problems;
3. create and review a separate v2 Story with acceptance criteria;
4. preserve v1 compatibility while adding task-context addressing;
5. add on-demand session lifecycle and the private browser-terminal gateway; and
6. migrate board fields only after the new routing path is proven.

## Questions for a future Story

- Which Codex thread identifier and resume mechanism are stable enough to persist?
- Where should context mappings and retention metadata live?
- How should GitHub display private links without exposing local session identifiers?
- Should secondary browser attachments be read-only to prevent competing input and resize events?
- What authentication and private-network boundary protects terminal access?
- How are clipboard images expired and removed safely?
- When should an ineffective implementation context be replaced instead of resumed again?
- How should existing `Original Agent` and `Current Agent` values migrate without interrupting v1?

## Non-goals

This proposal does not authorize:

- rewriting the current dispatcher before v1 validation;
- changing the active board fields or named-agent instructions;
- building a replacement Codex or ChatGPT user interface;
- exposing a terminal gateway directly to the public internet; or
- making private session history the only source of implementation or review reasoning.
