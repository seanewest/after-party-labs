# After Party

## What this project is right now

After Party is currently an exploratory testbed for a future Microsoft 365 and Azure
cybersecurity lab platform.

This pass may look functionally different from the eventual product. Its interface may be
a collection of individual actions used to prove end-to-end capabilities, discover
Microsoft's limitations, and identify reusable building blocks.

Those actions are not complete labs. They are atomized capabilities that may later be
combined into tenant preparation, scenarios, and investigations.

This pass may also explore realistic historical data, including whether mailbox contents,
files, conversations, ownership, and timestamps can be seeded or imported.

## Eventual product direction

The eventual After Party product is a cybersecurity lab platform for Microsoft 365 and
Azure.

A student connects an isolated tenant they control. After Party prepares the tenant,
creates realistic activity and misconfigurations, and gives the student labs where they
investigate what happened using Microsoft security products.

The tenant is not merely a place where questions are answered. The labs create real
Microsoft 365 and Azure state, activity, logs, alerts, and evidence for the student to
investigate.

The capabilities explored during this stage are intended to become the building blocks for
that future experience.

## Product experience

The eventual student experience should allow someone to:

1. Connect an isolated tenant they control.
2. Confirm that the required Microsoft 365 licenses and Azure access are available.
3. Install and validate After Party without manually building its infrastructure.
4. Prepare or repair the simulated organization.
5. Start a lab or scenario.
6. Investigate the resulting activity using Microsoft security products.
7. Reset or recreate the parts of the environment that are intended to be reusable.

Purchasing licenses and subscriptions remains the responsibility of the tenant operator.
After that, installation and preparation should be as automated as practical.

The final interface should be organized around labs, scenarios, preparation, and
investigation, not around individual technical actions.

## The simulated organization

After Party creates a fictional organization inside the tenant, including simulated users,
organizational structure, licenses, and other baseline configuration.

The baseline provides a stable environment that experiments and future labs can build on.
Its exact contents will evolve as we learn what makes the environment realistic and useful.

Possible baseline state includes:

- simulated users;
- licenses;
- groups and organizational relationships;
- Microsoft 365 configuration;
- security and authentication settings;
- background data representing ordinary organizational activity.

The baseline should remain distinguishable from temporary changes created by a particular
experiment, lab, or scenario.

## Labs and scenarios

A future lab or scenario will combine reusable capabilities to create something meaningful
for a student to investigate.

Examples may include:

- mailbox rules;
- permission changes;
- authentication activity;
- security-policy changes;
- messages and files;
- application activity;
- Azure infrastructure or configuration;
- alerts, incidents, and audit evidence.

A scenario should understand which of its changes are temporary and how they should be
reversed when appropriate.

Reversal does not mean erasing history. Audit logs, sign-in records, alerts, and other
historical evidence may remain after the active configuration is restored.

## Data and history

Activity in the tenant will naturally accumulate over time.

Some experiments and scenarios may delete or archive the email, Teams messages, SharePoint
files, OneDrive files, or other data they create. Others may intentionally leave them
behind.

The fact that an action historically occurred may remain visible even when its current state
has been cleaned up. That is acceptable and may add realism to the environment.

After Party may also seed or import historical background data, such as older conversations,
mailbox contents, and files shared between simulated users. This may become part of the
organization's continuity and background rather than belonging to one specific lab.

## Realism

Tenant-visible activity should look functionally real.

Messages, files, sign-ins, rules, alerts, incidents, and user activity should not describe
themselves as simulations, exercises, tests, or training unless that language would
naturally appear in the real Microsoft product or organizational context.

After Party itself may openly identify as a lab platform. The activity being investigated
should still resemble genuine organizational activity.

## Product boundaries

After Party is intended for isolated lab tenants controlled by the student or operator. It
should not assume that it is being installed into a normal production organization.

The product should not require After Party to centrally host the student's operational
infrastructure, tenant data, tokens, or lab execution. The working environment should live
within resources controlled by the student.

A public After Party installation may provide a shared entry point and application identity,
but the student's tenant remains the location where the environment and activity are
created.

## Success for this stage

This stage is successful when it helps establish:

- which useful Microsoft 365 and Azure capabilities are possible;
- what identities and permissions those capabilities require;
- what evidence the actions leave behind;
- what can be created, validated, reversed, or recreated;
- which behavior can be tested without relying on the live tenant;
- which capabilities can later be combined into realistic labs;
- which architectural choices should be carried into later versions.

It should leave behind reusable building blocks and a clearer path toward the eventual
product without requiring future versions to preserve the exploratory interface or
unnecessary complexity from this stage.
