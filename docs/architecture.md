# Architecture

## Purpose

This document describes the current technical direction for the exploratory After Party implementation.

It is not a permanent commitment to every component or boundary described here. The purpose of this stage is to establish a simple, testable architecture that can support capability experiments and later evolve into the product described in `product.md`.

When this document and historical code disagree, this document carries more weight.

## High-level shape

After Party has two main entry points:

- a student or operator using the public SPA;
- an agent or workflow running a live test through GitHub.

Both should enter the same tenant-side operation system.

```text
Student using GitHub Pages SPA ──┐
                                 ├──> After Party API
GitHub Actions live test ────────┘          │
                                            ▼
                                tenant-wide operation lock
                                            │
                                            ▼
                                  generic job or operation
                                            │
                                            ▼
                             Microsoft 365 and Azure changes
```

The main distinction between student use and development use should be how the caller authenticates and starts the operation, not a separate execution architecture.

## Hosting and ownership

The public SPA is hosted on GitHub Pages.

The official SPA uses one multitenant After Party app registration as its shared Microsoft sign-in and installation entry point.

The app registration lives in an Entra tenant controlled by the After Party project. It does not require After Party to host a backend, database, token store, or other operational infrastructure.

Everything that performs work for a student should live in resources controlled by that student:

- the After Party API;
- background jobs;
- managed identities;
- storage;
- token cache;
- operation records;
- the tenant-wide lock;
- Microsoft 365 and Azure resources created for the lab environment.

The multitenant app registration is the shared doorway. It should not become a centrally hosted control plane for student tenants during this stage.

## Installation

A student visits the official GitHub Pages SPA and signs into the multitenant After Party application using an administrator account for the tenant they want to use.

Microsoft creates an After Party enterprise application in that tenant when the required consent is granted.

The signed-in operator can then use the SPA to:

1. inspect the available Microsoft 365 and Azure environment;
2. explain missing prerequisites;
3. select the Azure subscription where After Party should run;
4. install or reconcile the tenant-side infrastructure;
5. prepare and validate the simulated organization.

Purchasing Microsoft 365 licenses and an Azure subscription remains outside After Party.

The Microsoft 365 licenses and Azure subscription should belong to the same Entra tenant.

## Tenant-side runtime

The current target is one Container Apps environment containing:

- a thin API;
- a generic on-demand job;
- a shared runtime managed identity.

The API receives operation requests, validates the caller, acquires the tenant-wide lock, and either completes short work directly or starts the generic job.

The generic job runs different capabilities based on an approved operation definition. It should not require a separate job architecture for every capability.

The API and job may use the same container image with different startup commands when that keeps the system simpler.

## Identities

### Multitenant After Party application

The multitenant application is used for:

- student and operator sign-in;
- initial installation and tenant inspection;
- authorizing requests from the SPA to the tenant-side API;
- acting as the OAuth client when a simulated user must authenticate.

During this exploratory stage, its permissions may be broader than the eventual product requires. Permissions should remain explicit and reviewable, but premature least-privilege work should not dominate the architecture.

The static site receives the application's public client ID, organizational authority, redirect
URI, and reviewed delegated-scope list through public configuration. These values identify the
OAuth client and are not credentials. Student consent, rather than the static configuration,
creates the enterprise application and grants delegated access in a student tenant.

The SPA is a public client. It must never contain:

- client secrets;
- private certificates;
- app-only access tokens;
- simulated-user tokens;
- refresh tokens.

### Runtime managed identity

The tenant-side API and jobs use an Azure managed identity for unattended work.

This identity may be used for:

- Azure Resource Manager operations;
- storage and lock access;
- Key Vault access;
- supported app-only Microsoft Graph operations;
- starting or coordinating tenant-side work.

The managed identity is created as part of the student-owned Azure infrastructure. It does not require another manually maintained app registration.

### Simulated users

Some actions must occur in the real delegated context of a simulated user.

In those cases, the trusted backend obtains and uses a delegated token for that user. The token remains in the backend and never enters the SPA.

Keep these concepts distinct:

- delegated user token: the action occurs as the simulated user;
- app-only token targeting a user's resource: the application performs the action;
- failed sign-in attempt: no token is obtained.

Do not present app-only activity as though the simulated user authenticated.

## Operation boundary

Every stateful live operation should use the same basic sequence:

```text
caller
→ After Party API
→ validate caller and requested operation
→ acquire tenant-wide lock
→ obtain the required identity
→ run the operation
→ record progress and result
→ release the lock
```

This should apply to:

- student actions from the SPA;
- GitHub Actions live tests;
- infrastructure reconciliation;
- baseline reconciliation;
- scenario setup and cleanup;
- manual testing from a locally served development SPA.

Mocked and offline tests do not need the live tenant lock.

## Tenant-wide lock

Each installed tenant has one shared operation lock stored in that tenant's Azure resources.

The lock prevents two stateful operations from changing the same tenant at the same time.

The lock must cover the full operation, including:

- infrastructure changes;
- baseline changes;
- scenario setup;
- the live action;
- validation;
- scenario cleanup.

A crashed operation should eventually release the system through lease expiration.

The lock is shared across the student's SPA, GitHub Actions, locally served development SPA, and tenant-side jobs. It is not a central lock hosted by After Party.

## State and token cache

The tenant-side runtime should have one clear cloud state plane.

Different kinds of state may use separate containers, records, or keys, but should not be spread across unrelated local files and services without a strong reason.

Expected state includes:

- the tenant-wide lock;
- operation status and evidence;
- deployment and version information;
- encrypted simulated-user token cache entries;
- non-secret installation metadata.

Secrets and token material must remain encrypted and accessible only to trusted tenant-side runtime identities.

Token cache entries must be separated by tenant, application, and simulated user so that one identity cannot receive another identity's token.

## Desired-state ownership

Different parts of the environment have different owners.

### Azure infrastructure

Bicep is the intended owner of Azure infrastructure, including:

- Container Apps;
- jobs;
- storage;
- Key Vault;
- managed identities;
- Azure role assignments;
- other Azure resources required by the runtime.

Bicep should support predictable create, validate, update, destroy, and recreate behavior.

### Microsoft 365 baseline

Microsoft365DSC is the intended owner of stable simulated-organization state, such as:

- users;
- licenses;
- groups and memberships;
- tenant configuration;
- security and authentication settings that belong to the baseline.

The exact contents of the baseline will grow as the project explores what is useful.

### Scenario and capability state

After Party operations own temporary or scenario-specific changes, such as:

- mailbox rules;
- permission changes;
- messages and files;
- authentication activity;
- Azure resources created for one experiment;
- security settings changed for one scenario.

A scenario should know which state it created and what should be restored afterward.

One specific object should not be placed under competing desired-state systems.

## Development and live testing

All implementation, coordination, review, and live testing should occur through GitHub.

Agents create changes through branches and pull requests. GitHub Actions performs live deployment and validation against the development tenant.

A PR live test should not assume that the tenant is already in the expected state.

The workflow should:

```text
acquire tenant lock
→ reconcile Azure infrastructure to the PR merge candidate
→ reconcile the Microsoft 365 baseline when needed
→ deploy the exact PR runtime
→ run the live test
→ record evidence
→ release the lock
```

If another PR previously changed the tenant, the new workflow reconciles it to the state required by the PR being tested.

Only one PR can actively control the shared development tenant at a time.

## Local SPA testing

Pull requests are built and served locally instead of publishing public preview deployments.

Local browser testing should be offline or mocked by default. It can be used for real end-to-end testing only when the tenant-side API is running the same commit.

```text
local SPA commit equals API commit
→ live actions allowed

local SPA commit differs from API commit
→ live actions blocked
→ redeploy this PR before testing
```

A locally served SPA must not silently operate against a different backend version. Modified or untracked local source must produce a non-matching dirty identity rather than claiming the clean `HEAD` commit.

## Version identity

The full Git commit SHA is the primary version identifier.

The SPA, API, job image, deployment record, and live-test evidence should identify the exact commit they came from.

A live result should make it possible to determine:

- source commit;
- container image digest;
- API revision;
- operation ID;
- relevant deployment result.

Avoid adding separate version systems unless they represent something genuinely independent from the source commit.

## Testing

The architecture should make important behavior fast and efficient to test.

Tests should not unnecessarily depend on:

- current GitHub deployment state;
- stale browser or service caches;
- a particular tenant state;
- a live Microsoft service when that service is not the thing being tested.

Mocked and local tests should use the same underlying operation logic as the real system whenever practical.

Live tests should prove the parts that genuinely depend on Microsoft 365, Entra, or Azure.

## Architectural invariants

The following should remain true unless explicitly reconsidered:

- The SPA never contains private credentials or simulated-user tokens.
- Student actions and development live tests use the same tenant-side operation boundary.
- Every stateful live operation uses the tenant-wide lock.
- Operational infrastructure and state live in the student's tenant.
- App-only activity is not described as delegated user activity.
- The exact Git commit is visible in deployments and live evidence.
- Existing architecture is not preserved merely because it already exists.
- New services, identities, execution paths, and state stores require a meaningful reason.
- Development convenience should not create a second product architecture.

## Expected evolution

This architecture is intended to support exploration.

Capabilities may reveal that some boundaries need to change, that certain Microsoft operations require a different identity, or that a component can be removed or consolidated.

Changes should be evaluated by whether they improve the overall system, not by whether they preserve this first draft exactly.

## Security posture for this stage

This stage prioritizes learning and architectural clarity over final hardening. Permissions
may be broader, and some protections may be deferred, when they can later be narrowed without
changing the system's basic shape.

Shortcuts that would create the wrong trust boundaries are not acceptable. Secrets,
private credentials, and simulated-user tokens must never be placed in the SPA.
