# Development

## Durable development state

All development happens through GitHub issues, branches, pull requests, reviews, and Actions.

GitHub is authoritative for product goals, constraints, current phases, durable conclusions,
acceptance evidence, and human gates. Each goal also has one persistent local Codex conversation
and execution context for its evolving technical plan and live work. The local dispatcher must make
that context recoverable; it does not make private runtime state authoritative over GitHub.

One persistent goal context owns implementation, review follow-up, merge, and proof. It may use
temporary subagents for bounded independent review or research without transferring ownership.

## Human feedback and legibility

The human is part of the project's ongoing feedback loop, not merely an approver at the end.

Talk to the human like a person, not like an agent writing a status report. Lead with the point,
use plain language, and add structure or technical detail only when it helps the human understand
or act.

Surface meaningful changes in understanding, tradeoffs, and decisions. Keep routine mechanics in
the issue or pull request. Pull requests and meaningful comments should briefly explain what
changed, why it matters, and what evidence supports it; the human should not have to reconstruct
the meaning from implementation details.

## Issues and pull requests

Issues should preserve the purpose of the work, its important context, and any decisions or
constraints that shaped it. They should leave room for the implementing agent to determine
the details.

Pull requests are the durable record of what was built, tested, and learned.

When a task reveals a broader problem or a better direction, surface it rather than quietly
expanding the task, ignoring the discovery, or following the original instruction after its
assumptions no longer make sense.

## Shared product and development paths

Development and live testing use the same SPA entry point and tenant-runtime operation path as the
product. GitHub Actions tests code and publishes artifacts, but it has no credential or federated
identity for the development tenant.

## Live testing

The development tenant is shared, and its current state should never be assumed.

Before a pull request is tested live through the SPA, the environment should be reconciled to the
state expected by that pull request. Deployment, reconciliation, testing, and cleanup should be
protected by the same tenant-wide lock.

This allows different pull requests to take turns using the tenant:

    PR 20 acquires the lock
    → reconciles the tenant to PR 20
    → runs its test
    → releases the lock

    PR 23 acquires the lock
    → reconciles the tenant to PR 23
    → runs its test
    → releases the lock

    PR 20 runs again
    → reconciles the tenant back to PR 20
    → runs its test

No pull request should depend on whatever state another pull request happened to leave
behind.

Persistent history such as audit logs, sign-in records, messages, and other accumulated
evidence may remain. Only state the project intentionally manages should be reconciled.

## Local SPA testing and versioning

Pull requests are tested locally and do not publish public preview sites. See [Local development](local-development.md) for the command used to build and serve the SPA.

The `GitHub Pages` workflow publishes the production site from `main` at:

```text
https://seanewest.github.io/after-party-labs/
```

The local server uses the same Pages build logic as production, with `/` as its base path. A worktree with modified or untracked files receives a `<commit>-dirty` identity that cannot match a deployed API commit. Local browser testing should remain offline or mocked unless the tenant-side API and runtime are deliberately deployed from the same clean commit and the operation follows the live-testing requirements below.

Use the full Git commit SHA as the main identity of a development version.

A live test should evaluate the pull request as it would be merged with the current target
branch, rather than relying on an outdated branch state.

## GitHub Actions

GitHub Actions handles offline builds, tests, artifact publication, and Pages deployment. It does
not authenticate to the development Azure or Microsoft 365 tenant. Live validation is performed
through the same SPA flow used by a student.

The Pages workflow builds the runtime container from the exact main commit, publishes it to GHCR,
resolves the immutable digest, and stamps that digest and commit into the site. Pull-request CI
builds the same Dockerfile without publishing or contacting a live tenant.

### One-time GHCR bootstrap

GitHub Container Registry creates the runtime package as private on its first publication. The
student-installed Container App must be able to pull the image without a GitHub account, repository
access, or registry credentials, so the Pages workflow refuses to deploy the site until an
anonymous pull succeeds.

The first run therefore publishes the package and then stops with a clear error. A repository owner
must open the `after-party-labs/runtime` package settings, choose **Change visibility**, and confirm
**Public**. Package visibility cannot be changed back from public, so this remains an explicit human
bootstrap action. Rerun the failed Pages workflow after the package becomes public. Later runs keep
verifying anonymous access before publishing a new site version.

Live testing is appropriate when a change needs proof against Microsoft services or affects
the real tenant path. Changes that do not depend on the live environment should not require
it.

## Container-based testing

Code intended to run in Container Apps should be developed and tested in the same container
image wherever practical. Do not wait for an Azure deployment to discover behavior that can
be reproduced inside the container.

For browser automation, prefer the fastest feedback loop: the agent should run the container,
inspect screenshots and browser state itself, adjust the implementation, and retry directly.
GitHub Actions may provide this loop when the agent environment cannot, and should verify the
same image before deployment.

Any browser run that reaches the live Microsoft tenant or performs a real authentication
attempt must acquire the tenant-wide lock. Mocked or otherwise offline container tests do not
need the lock.

The final live test should deploy the exact image digest that was verified. Azure should prove
the Microsoft and platform integration, not serve as the main browser-development loop.

## Goal-context workflow

The project board contains product goals, not an engineering org chart. A goal records its outcome,
constraints, success criteria, durable evidence, and genuine human gates. One persistent Codex
context owns an actionable goal until it reaches Done.

The project uses these statuses:

- **Backlog**: recognized work that is not ready to start.
- **Ready**: a sufficiently specified goal that the dispatcher may start.
- **In Progress**: the goal context is planning, implementing, testing, reviewing, fixing, waiting
  for a machine event, merging, deploying, or gathering acceptance proof.
- **Human Needed**: progress requires a real human decision, unavailable authority, a destructive
  or consequential action outside standing authorization, or subjective acceptance that cannot be
  automated.
- **Done**: the acceptance criteria are satisfied and durable proof is recorded.

Retired ownership and routing fields such as `Original Agent`, `Current Agent`, and Story/Task do
not determine dispatch. Historical comments that use the old workflow are evidence only. The
current goal body and latest explicit human direction win when records conflict.

### Starting and resuming a goal

The target dispatcher behavior is: moving an eligible goal to Ready creates or resumes exactly one
context, stores its stable Goal Context ID, and writes a clickable loopback Context URL to the card.
Starting the work moves the goal to In Progress. The URL opens the same live Codex surface used by
automation, including an already-running turn; it must support steering, follow-up messages, image
paste, detach, and reattach without changing conversations.

The completed dispatcher resumes the same context when the goal, linked pull request, review
feedback, checks, merge, deployment, or human response changes. Busy contexts retain events in
order. An idle or sleeping context resumes automatically. Duplicate observations must not start
another context or repeat an unsafe action.

Waiting for a machine-observable event ends the current model turn. The durable event later wakes
the same context; a model turn does not poll or busy-wait. A process, WSL, tmux, or terminal failure
may stop execution but must not lose the goal, conversation identity, branch, worktree, or pending
event.

### External waits and continuations

Never hold a model turn open merely for time, CI, quota, deployment, or another
machine-observable condition. Use productive offline work or a standard alternative interface
first. If a wait remains, persist a concise checkpoint, register a deterministic timer or event
continuation, and end the model turn. When no automated wake-up mechanism exists, report the
blocker once and stop rather than publishing unchanged status repeatedly.

Services persist their retry deadline and use bounded exponential backoff; they do not crash-loop
or rapidly poll an unavailable dependency. An administrative ordering dependency such as a
project-field update is eventually consistent and cannot block independent implementation, tests,
commits, pushes, or REST operations.

### Planning, branches, and review

The owning context keeps its technical plan internally and updates it as evidence changes. GitHub
stores durable conclusions and acceptance evidence, not simulated internal assignments.

Repository changes normally use a dedicated branch and a pull request linked to the goal. The same
context owns the pull request through review fixes and merge. It may create temporary subagents for
bounded research or adversarial review. Subagents do not claim board cards, become persistent
workers, or create handoff loops. The owning context records material review conclusions on the
pull request and either fixes them or explains why no change is needed.

Review is not a board column. A goal remains In Progress while checks or review are pending. Merge a
satisfactory, authorized pull request once required checks and evidence are complete. Continue
through deployment and automated acceptance proof where the goal requires them.

### Human gates

Human Needed is not a general approval or waiting state. Use it only when the remaining step
requires product direction, a material architecture choice, new authority, a destructive or
consequential live action outside standing authorization, or inherently subjective acceptance.

Put one exact decision or action and the supporting evidence on the goal, stop safely, and let the
dispatcher resume the same context after the response. The human does not relay messages among
implementation and review workers.

### Durable event contract

GitHub is authoritative; the local dispatcher is the execution and recovery layer. Runtime
databases, credentials, transcripts, locks, and machine-specific state remain outside Git.

Every delivered event has a stable ID. Source checkpoints, enqueueing, receipts, retries, and final
outcomes are durable and idempotent across restarts and overlapping polls. Delivery may be at least
once internally, but recipient-side receipts and action-level idempotency must keep duplicate
events from duplicating goal work. An ambiguous post-work failure is surfaced for safe recovery,
not replayed blindly.

Automated delivery and the browser terminal share one conversation and execution surface. Never
start a hidden competing Codex client. The loopback URL contains no reusable secret and resolves
only through the maintainer's local dispatcher.

Operator commands, trust boundaries, recovery behavior, and the current migration boundary are in
the [dispatcher guide](../dispatcher/README.md).

## Artifacts

Generated logs, screenshots, and test artifacts should remain outside Git unless they provide necessary durable evidence; preserve only the smallest sanitized record needed, in a clearly named evidence directory.
