# Decisions

## Adopted decisions

### Persistent goal contexts

Each actionable GitHub goal is owned by one persistent Codex context from initial planning through
implementation, testing, adversarial review, fixes, merge, deployment, and acceptance proof.
GitHub remains authoritative for the goal, constraints, current phase, durable evidence, and human
gates; the context keeps its evolving technical plan internally.

The dispatcher deterministically creates or resumes that context when relevant durable events
change. A local browser terminal exposes the same live conversation for observation, steering,
image paste, detach, and reattach. Context identity is attached to the goal rather than to a named
worker, terminal, worktree, or process, and recovery must not depend on any of those resources
remaining alive.

Temporary subagents may provide bounded research or adversarial review inside the owning context.
They do not become board owners or create a separate implementation/review handoff workflow. The
board uses Backlog, Ready, In Progress, Human Needed, and Done; review and machine-event waits remain
In Progress. Runtime state remains local and outside Git.

Machine-observable waits are durable continuations rather than live model work. The context first
uses productive offline work or a standard alternative interface, then checkpoints and ends its
turn with a deterministic timer or event wake-up. Services persist bounded exponential backoff;
administrative project-field consistency never blocks independent implementation or publication.

### Universal sign-in

The official SPA uses one multitenant After Party application registration. Runtime
infrastructure remains inside the student tenant.

### Infrastructure ownership

Azure infrastructure is managed by Bicep. Stable Microsoft 365 baseline state is managed by
Microsoft365DSC. Scenario-specific state is managed by After Party operations.

### Shared operation boundary

Student actions and development live tests use the same API, job system, and tenant-wide lock.

### Version identity

The full Git commit SHA is the authoritative version identifier.

### Security during exploration

For this pass, After Party uses one main application identity with intentionally broad,
bounded permissions to keep the architecture simple while responsibilities are still being
explored.
