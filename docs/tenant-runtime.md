# Tenant runtime bootstrap

## What this gives the student

The future **Install or repair tenant runtime** card creates one small Azure runtime inside the
student's selected subscription. The card must show the subscription, tenant, region, required
Azure role, resources, and exact After Party commit before the student confirms any change.

This task defines and tests that deployment path. It does not deploy anything live. The first live
deployment belongs to issue #26 and requires the human to authorize the exact target and changes.

## What gets created

One subscription-scope Bicep deployment owns:

| Resource | Purpose |
| --- | --- |
| Required resource-provider registrations | Enables only Container Apps, managed identity, and Storage when they are not registered yet. |
| Resource group | One clear ownership and teardown boundary for the runtime. |
| Container Apps environment | Hosts the tenant-side API without a separate cluster. |
| Container App | Provides the single HTTPS API boundary used by the SPA and live tests. |
| User-assigned managed identity | Gives the API a passwordless runtime identity. |
| Storage account and private `state` blob container | Holds operation status and the [tenant operation lock](tenant-lock.md). |
| `Storage Blob Data Contributor` assignment | Lets only the runtime identity read and change that state container. |

There is no generic job yet because the first operation does not require one. There is also no
Key Vault, registry, Log Analytics workspace, simulated-user authentication, Microsoft365DSC
baseline, or second state system in this slice.

The Container App is an HTTPS shell for the API image pinned in the plan. Issue #23 owns caller and
tenant authorization inside that API. The live deployment cannot occur until that authorization
path exists and the deployed image is pinned to a digest from the same commit.

## Preflight contract

[`runtime/bootstrap.mjs`](../runtime/bootstrap.mjs) is the shared, offline-testable contract. A
caller supplies the operator's explicit selection plus current Azure Resource Manager evidence:

- selected tenant ID, subscription ID, Azure region, resource-group name, and runtime name;
- the full 40-character source commit and a public container image pinned to a SHA-256 digest;
- the accessible subscription's ID, name, tenant, and state;
- subscription locations and resource-provider metadata; and
- the caller's effective Azure control-plane permissions.

The planner returns no deployment plan unless all of these are true:

- Azure returned the exact selected subscription and it is enabled;
- the subscription belongs to the signed-in tenant;
- the region is available to the subscription and supports Container Apps, managed identity, and
  Storage;
- the provider metadata confirms support, and the operator can register any required provider that
  is not ready yet; and
- the operator can create the resources and the container-scoped role assignment.

The accepted plan lists provider registrations before the resource deployment. Registration is an
Azure change and therefore happens only after the operator confirms the card; repeating it is
safe, and deployment waits until registration finishes.

The simplest role choice is **Owner** on the selected subscription. The narrower documented
combination is **Contributor** plus **Role Based Access Control Administrator**. Custom roles also
work when their effective permissions contain every action in the contract. Contributor alone is
not enough because it cannot create the managed identity's Storage role assignment. Azure role
assignment changes can take time to propagate, so a later live operation must report that state
without treating a partial install as success.

The planner uses current provider metadata rather than a hard-coded region list. Azure services do
not support every resource type in every region, and a subscription may have additional placement
limits.

## Install, repair, and verify

The accepted plan targets [`infra/main.bicep`](../infra/main.bicep) at the exact subscription. The
template checks the target subscription and tenant again before creating its resource group and
delegating to [`infra/runtime.bicep`](../infra/runtime.bicep).

Install and repair are the same incremental deployment with the same deterministic names. Running
the deployment again reconciles missing or changed runtime resources instead of creating a second
runtime. A new commit changes the deployment record and resource tags while preserving the owned
resource identities.

Success is not inferred from an Azure command exit alone. `verifyRuntimeDeployment` requires a
`Succeeded` deployment and checks the returned tenant, subscription, region, commit, resource
group, API, managed identity, state container, and HTTPS API URL against the original plan. Missing
outputs, partial deployments, and mismatched resources fail closed with a repair message.

The Bicep template is compiled in CI. Its code path is intentionally the same one later used by the
SPA operation and the authorized live test.

Deployment verification also requires the exact tenant lock blob path,
`locks/tenant-operation.json`. The Container App receives that path as
`AFTER_PARTY_TENANT_LOCK_BLOB`; a missing or changed value is a partial or mismatched runtime rather
than a successful install. The lock lifecycle and evidence contract are documented in
[Tenant operation lock](tenant-lock.md).

## Ownership and teardown

The runtime resource group is the Bicep ownership boundary. A future runtime teardown may delete
that group only after verifying its subscription, tenant, expected name, and After Party ownership
tags.

Deleting this runtime must not delete or alter:

- the developer-owned multitenant application registration;
- the student tenant's After Party enterprise application or consent grants;
- unrelated Azure resource groups or resources; or
- Microsoft 365 baseline or scenario data.

Student enterprise-application uninstall remains the separate process in
[Multitenant application](multitenant-application.md). This task does not add a live runtime teardown
command because no runtime has been authorized for deployment yet.

## Microsoft references

- [Managed identities in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity)
- [Assign an Azure role for Blob data](https://learn.microsoft.com/en-us/azure/storage/blobs/assign-azure-role-data-access)
- [Azure resource providers and supported locations](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-providers-and-types)
- [Azure built-in roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles)
