# Development

## GitHub-only development

All development happens through GitHub issues, branches, pull requests, reviews, and Actions.

GitHub is the shared memory of the project. Agents should not depend on persistent local
environments, private conversations, or context that is not recorded there.

Implementation and review should normally be performed by separate agents.

## Human feedback and legibility

The human is part of the project's ongoing feedback loop, not merely an approver at the end.

Issues, pull requests, and meaningful comments should make the main purpose and significance
of the work easy for the human to understand. Technical detail should still be recorded for
agents, but the human should not have to reconstruct the meaning of the work from it.

Use judgment about what is worth surfacing. Communicate meaningful changes in understanding,
tradeoffs, opportunities to simplify, or reasons the project may need to adjust direction.
Routine implementation detail does not need to be elevated.

Every pull request should leave behind a clear conceptual account of what the work
accomplished and what it means for the larger project, alongside the technical record.

Clear communication is part of engineering. When a change is difficult to explain simply,
consider whether the underlying code, architecture, or product has become unnecessarily
complicated.

## Issues and pull requests

Issues should preserve the purpose of the work, its important context, and any decisions or
constraints that shaped it. They should leave room for the implementing agent to determine
the details.

Pull requests are the durable record of what was built, tested, and learned.

Reviewers should complete the pull request lifecycle. When the current head has no blocking findings, required checks or evidence are satisfactory, and the pull request is mergeable, merge it instead of only approving it or reporting that it looks good. If draft status is the only obstacle, mark it ready and then merge it. Do not merge while a blocker, required validation, or human decision remains.

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

Issues are the project's work queue, and a GitHub Project tracks their current status.

Agent work begins from issues marked Ready. The human starts an agent task with the issue, and the agent
records its progress and resulting pull request in GitHub.

When work requires human action or a decision, assign the issue to the human, move it to Waiting for
Human, and leave a clear, concise request with an @mention. Do not make the human infer the required
action from technical discussion.

After the human responds, the issue should either return to Ready, continue through Review, or move to
Done.

The initial workflow is human-directed: agents do not automatically claim every Ready issue. Automatic
task pickup may be introduced later if it improves the process without making coordination harder to
understand.

When an agent discovers something meaningful during the work, communicate it to the human in
the active task conversation and also preserve it in the issue or pull request. The conversation
supports the immediate feedback loop; GitHub is the durable record for other agents.

## Artifacts

Generated logs, screenshots, and test artifacts should remain outside Git unless they provide necessary durable evidence; preserve only the smallest sanitized record needed, in a clearly named evidence directory.
