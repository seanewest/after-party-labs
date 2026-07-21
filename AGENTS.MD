# AGENTS.md

## Working principles

### Testability

Prefer architecture that is easy and efficient to test. We should not have to wait on GitHub state, deployments, stale caches, or a particular live environment unless that is actually the thing being tested.

Tests should use the same underlying paths and behavior as the real system whenever practical. Avoid separate testing-only plumbing when the normal product path can be made testable instead.

Live testing will still be necessary, but it should be used for behavior that genuinely depends on the live system—not because the architecture makes everything else difficult to test.

### Simplicity

Prefer solutions that keep the overall system simple. Consider the effect of a change on the whole project, not only whether it solves the immediate task cleanly.

This applies at several levels:

- architectural simplicity;
- conceptual simplicity;
- code simplicity.

Be cautious about adding new services, identities, execution paths, state stores, workflows, abstractions, or layers. A component may be reasonable on its own while still making the overall system unnecessarily complicated.

Prefer solutions that are easy to explain at a high level and whose code is clear, direct, and reasonably easy for another agent to understand and change.

Look for opportunities to consolidate duplicated responsibilities, remove things that are no longer needed, and simplify earlier solutions.

Do not assume that existing code or historical architecture is correct merely because it already exists. It may have been experimental, temporary, duplicated, or made obsolete by later work. Explicitly adopted decisions should generally be followed, but raise them with the human when reconsidering one could produce a significant improvement.

Refactoring is encouraged when it makes the system meaningfully simpler or more coherent. Raise the issue with the human before making a major change to the architecture or product direction.

Avoid overengineering.

### Goal-context work

GitHub goals are the durable source of product direction, constraints, acceptance criteria, current
phase, evidence, and genuine human gates. One actionable goal has exactly one persistent Codex
context that owns the work from planning through implementation, testing, review fixes, merge,
deployment, and acceptance proof. Context identity belongs to the goal, not to a permanent worker
persona.

The owning context keeps and revises its technical plan internally. It may create temporary
subagents for bounded research or adversarial review, but those subagents do not claim board cards,
open parallel ownership loops, or hand pull requests among permanent workers. The owning context
decides how to apply findings and records material conclusions on the pull request.

Repository changes normally use a dedicated branch and pull request linked to the goal. The same
context follows review comments, checks, merges, deployments, and human responses until the goal is
complete. Review is an activity within that ownership, not a board state or handoff. If a pull
request is ready and authorized to merge, merge it instead of waiting for a separate assignment.

The project board uses **Backlog**, **Ready**, **In Progress**, **Human Needed**, and **Done**.
`Human Needed` is reserved for a product or architecture decision, new authority, a destructive or
consequential live action outside standing authorization, or subjective acceptance that cannot be
automated. Implementation, review, CI waits, event-driven sleeps, merge, deployment, and evidence
gathering all remain `In Progress`.

When GitHub records conflict, the current goal body and latest explicit human direction take
precedence over historical comments and retired workflow fields. Do not use `Original Agent`,
`Current Agent`, Story/Task routing, signed-persona comments, or cross-agent PR handoffs to decide
work.

The dispatcher being built must start or resume the goal's one context when durable GitHub or
runtime events change. Event handling must be durable and idempotent. Busy contexts retain ordered
events; waiting for a machine-observable event ends the current model turn and the later event
resumes the same context. Automated delivery must not create a hidden competing Codex client.

External waits are continuations, not live model work. Never keep a model turn alive merely to
wait for time, CI, quota, deployment, or another machine-observable event. First do productive
offline work or use a standard alternative interface. Before sleeping, persist one concise
checkpoint and register a deterministic timer or event continuation, then end the model turn. If
automated wake-up is unavailable, report the blocker once and stop; never repeatedly announce an
unchanged state. Long-running services use bounded exponential backoff instead of crash loops or
rapid external polling. Administrative ordering, including eventual project-field updates, must
not block independent code, tests, pushes, or other productive work.

During the bootstrap migration, existing named-worker commands are compatibility plumbing only.
They must not assign new goals or revive the retired ownership workflow. Until the goal-context
path is implemented and proven, the context owning Goal #34 performs this work directly.

Only board goals are dispatched automatically unless the human explicitly asks for other work.
Keep runtime databases, credentials, transcripts, locks, and machine-specific state outside Git.
See [development](docs/development.md#goal-context-workflow) and the
[dispatcher guide](dispatcher/README.md) for the operating contract.

A focused goal should not quietly grow into a materially different product or architecture. Put a
clear decision and the available evidence on the goal when that boundary is reached.

### Autonomy and human interaction

Work independently when the direction is clear.

Do not create unconventional workarounds, major new architecture, broad new permissions, or substantial additional complexity merely to avoid asking the human for input.

Ask for input when a decision meaningfully affects:

- product direction;
- the overall architecture or mental model;
- permissions or trust boundaries;
- destructive or consequential live actions;
- a tradeoff that would be difficult or expensive to reverse.

When communicating with other agents, provide the technical detail they need.

When communicating with the human, write like a person, not an agent status report. Lead with the point, use plain language, and include only the structure and detail that help the human understand or act. Put routine technical context elsewhere.

### Live environments and intentional insecurity

Do not perform destructive or externally consequential live actions without explicit authorization.

Some insecure states may be intentional parts of the product. Do not treat something as a defect merely because it is insecure. Consider whether the insecurity is intentional, properly scoped, reversible where required, and prevented from affecting anything outside its intended boundary.

### Reflection and communication

Treat communication with the human as part of the work and keep the larger purpose of the task in view.

Use judgment about what is worth communicating. Surface meaningful changes in understanding, tradeoffs, opportunities to simplify, or reasons the project may need to adjust direction. Do not burden the human with routine implementation detail.

Pull requests and meaningful review comments should make their broader significance clear in simple, conceptual terms, so the human does not have to reconstruct it from technical details.

### Languages

Keep the number of implementation languages small. Prefer TypeScript for application code,
automation, tooling, and tests.

Use PowerShell, Bash, or another language when the platform or task genuinely calls for it,
rather than introducing it as an alternative implementation path.
