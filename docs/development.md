# Development

## GitHub-only development

All development happens through GitHub issues, branches, pull requests, reviews, and Actions.

GitHub is the shared memory of the project. Agents should not depend on persistent local
environments, private conversations, or context that is not recorded there.

Implementation and review should normally be performed by separate agents.

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

Development and live testing should use the same underlying operation path as the product
wherever practical.

The entry point may differ: a student may begin in the SPA, while an agent begins through
GitHub Actions. After that, avoid separate development-only plumbing unless it is genuinely
necessary.

## Live testing

The development tenant is shared, and its current state should never be assumed.

Before a pull request runs a live test, the environment should be reconciled to the state
expected by that pull request. Deployment, reconciliation, testing, and cleanup should be
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

GitHub Actions should handle builds, deployments, and live tests, using federated
authentication rather than long-lived local credentials.

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

## Work coordination

Issues are the project's canonical work items. Each issue stays on the Development project through
implementation and review. A pull request must link its issue, normally with `Closes #<number>`.
The issue card is authoritative for ownership and status; the pull request records the change,
validation, and review.

The project uses these statuses:

- **Backlog**: recognized work that is not ready to begin.
- **Ready**: actionable work that an eligible agent may claim.
- **In Progress**: the implementing agent has the next action.
- **Waiting for Human**: progress requires a human decision or action.
- **Review**: the linked pull request is ready for another agent to review.
- **Done**: the work has been merged or otherwise completed.

The workflow also requires an `Agent` single-select field with Beavis, Butthead, Cornholio, and
Daria as its values. It records the implementing agent, not the current reviewer. A Ready issue
with no Agent may be claimed by any suitable agent; one with an Agent is reserved for that agent.

### Checking the board

When the human says `check the board`, run this loop in order until nothing is actionable:

1. Resume owned unfinished work. Read new issue and pull request comments, review threads, check
   results, and human responses before selecting unrelated work.
2. If no owned item needs action, claim a suitable pull request in Review that was created by
   another agent.
3. If no review is available and there is no unmerged implementation pull request, claim the first
   compatible Ready issue in board order.
4. Otherwise stop and tell the human there is no actionable work.

Run the loop again after an action changes an item's state, including after opening a pull request,
completing a review, merging, receiving a human answer, or finishing requested changes. Agents do
not poll continuously; once the loop is empty, wait for the human to say `check the board` again.

### Claiming implementation work

Before substantive work, confirm that the issue is still Ready and its Agent is blank or already
set to you. Set the Agent to yourself, move the issue to In Progress, and leave a signed claim
comment, for example:

    [BEAVIS] Claimed for implementation. Beginning work now.

If another agent has claimed or is reserved for the issue, continue the dispatch loop without
working on it.

An agent may have only one unmerged implementation pull request at a time. It may review another
agent's work while its own pull request waits, but it may not claim another Ready issue until its
pull request is merged, closed, or explicitly reassigned.

### Pull requests and review

When implementation and required validation are complete, the implementer links the pull request
to the issue, marks the pull request ready, moves the issue to Review, and leaves a concise handoff:
what changed, how it was tested, and anything the reviewer should pay attention to.

An agent must not review its own implementation. Before reviewing another agent's pull request,
leave a signed comment claiming the review. The Agent field remains set to the implementer.

The reviewer completes one of these outcomes:

- If the current head is satisfactory and the required checks and evidence are complete, merge the
  pull request and move the issue to Done.
- If implementation changes are needed, explain them clearly and move the issue to In Progress.
- If a human decision or action is needed, explain it clearly and move the issue to Waiting for
  Human.

The original implementer handles requested changes and returns the issue to Review when it is
ready. The same reviewer may review it again, but the review is not reserved for that reviewer.

### Human attention

Waiting for Human is only for work that cannot safely continue without a human decision or action;
it is not a general approval stage. Address the human directly in a short, natural comment that
says what is needed, why, your recommendation when there is a choice, and what will happen next.
Do not turn the request into a form or a long agent report.

The Agent remains the implementer. On the next board check, the agent reads the response, moves the
issue to the appropriate status, and continues. The human does not need to update the project card.

### Durable handoffs

Because all agents may use the same GitHub account, important comments begin with the agent's name
in brackets, for example `[DARIA]`.

Project fields are authoritative for ownership and next action. Comments preserve the reasoning,
evidence, questions, and handoff context behind status changes.

## Artifacts

Generated logs, screenshots, and test artifacts should remain outside Git unless they provide necessary durable evidence; preserve only the smallest sanitized record needed, in a clearly named evidence directory.
