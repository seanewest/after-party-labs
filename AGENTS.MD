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

### Distributed agent work

All implementation, coordination, review, and live validation should work through GitHub issues, tasks, branches, pull requests, comments, and actions. Do not depend on a persistent local agent environment, private conversation context, or unrecorded local state.

Repository changes should normally be developed on a dedicated branch and delivered through a pull request. Review findings and follow-up discussion for a pull request must be recorded on that pull request, not only in chat or a local report.

If an agent knows its assigned name, it should prefix every GitHub issue comment, pull request comment or review, and pull request title with `[NAME]` (for example, `[CORNHOLIO] ...`).

Most code will be written and reviewed by agents working on separate tasks. Leave enough context in issues, pull requests, review comments, tests, and documentation for another agent to understand the reasoning and continue the work independently.

Implementation and review should normally be performed by separate agents. A reviewer should be able to understand the change from the repository, issue, pull request, tests, and evidence rather than relying on the implementer’s private context.

A focused task should not quietly grow into a large redesign. When a task reveals a broader architectural problem, surface it clearly rather than either ignoring it or expanding the work without discussion.

Use subagents when work can be divided into genuinely independent streams with little duplicated effort, coordination, or merge risk. Use judgment about whether the likely time saved justifies the additional usage; do not delegate merely to create parallel activity.

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

When communicating with the human, lead with the main idea. Keep the explanation clear and direct, with supporting details when they help with the decision.

Human requests should state only the action and expected response. Put detailed technical context elsewhere unless the human genuinely needs it to perform the action.

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
