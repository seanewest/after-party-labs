# Decisions

## Adopted decisions

### GitHub-only agent workflow

All implementation, review, deployment, and live testing runs through GitHub. Persistent local
agent workspaces are not part of the architecture.

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
