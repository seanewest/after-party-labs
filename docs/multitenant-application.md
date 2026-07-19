# Multitenant application

After Party uses a Microsoft Entra multitenant application as its shared sign-in and
installation entry point. Its application object is the project-owned, home-tenant application
registration. A student's
first identity consent may create the corresponding enterprise application in the student's
tenant. A later installation consent adds the reviewed lab-management permissions to that same
enterprise application.

The setup below creates only the home-tenant application object. It does not create a client secret,
certificate, service principal, or permission grant. The downloaded scripts are pinned to
reviewed commits so their contents do not change when the repository branch moves.

## Create the application

1. Open [Azure Cloud Shell](https://shell.azure.com/) and select **Bash**.
2. Confirm that Cloud Shell is signed into the tenant that should own the app registration:

   ```bash
   az account show --query '{tenantId:tenantId, subscription:name, user:user.name}' --output table
   ```

3. Review the pinned [create script](https://github.com/seanewest/after-party-labs/blob/3df0e58524fe933095187d3a4bda71b791fe9414/scripts/create-multitenant-app.sh),
   then paste this command into Cloud Shell:

   ```bash
   bash <(curl -fsSL 'https://raw.githubusercontent.com/seanewest/after-party-labs/3df0e58524fe933095187d3a4bda71b791fe9414/scripts/create-multitenant-app.sh')
   ```

The script creates and verifies the registration, then prints its Application (client) ID and
home tenant ID. Save both values. It also configures the production and local SPA redirect URIs
and the delegated Microsoft Graph permissions listed below.

## Reconcile the existing home-tenant application

Reconciliation changes broad permission settings on the live home-tenant application object, so run it only
after that live change has been explicitly authorized. Review the same pinned script, confirm the
signed-in tenant, then paste this exact-ID command into Cloud Shell:

```bash
AFTER_PARTY_APP_ID='9edaa951-658e-4be2-9623-ee906cb604b2' \
EXPECTED_TENANT_ID='92563293-315c-4b6c-9b90-bcb47ee8c970' \
CONFIRM_RECONCILE='9edaa951-658e-4be2-9623-ee906cb604b2' \
bash <(curl -fsSL 'https://raw.githubusercontent.com/seanewest/after-party-labs/3df0e58524fe933095187d3a4bda71b791fe9414/scripts/create-multitenant-app.sh')
```

The script refuses to reconcile by display name. Before changing anything, it verifies the home
tenant, exact client ID, application object, and display name. The same tenant may also contain the
local enterprise application derived from this registration; when it does, the script verifies
that exact service principal and preserves it. A missing local service principal is also valid.
Mismatched or duplicate objects fail closed.

## Permission boundary

These permissions are intentionally broad while After Party is being explored. They are suitable
only for an isolated lab tenant controlled by the student or developer. They are delegated
permissions: work is performed in the context of a signed-in user and remains limited by that
user's access. They are not app-only permissions for unattended runtime jobs.

Adding a permission to the home-tenant application object does not grant it in a student tenant. Basic
identity consent during sign-in may create the tenant's enterprise application, but it does not
grant the broad permissions below. The student installation flow must show that requested access,
obtain the appropriate consent, and verify the resulting grants.

The registration also exposes `AfterParty.Operate` as both an admin-consent-only delegated scope
and an application role for the tenant-owned After Party API. The delegated scope is preauthorized
only for the same official SPA application. The application role is assigned only to the
student-owned runtime managed identity, including when GitHub Actions federates as that identity.
Both paths receive a token from the student tenant for its local enterprise application and enter
the same tenant API; the API does not contact the application object's home tenant.

The same one-time administrator consent also includes Azure Service Management delegated
`user_impersonation`. The SPA can therefore request an Azure Resource Manager token silently after
connection and install or repair the tenant runtime in subscriptions where that operator has the
required Azure RBAC. This is intentionally broad for the isolated-lab exploration pass; later
hardening will replace it with a narrower permission model.

| Microsoft Graph permission | What After Party can explore |
| --- | --- |
| `User.Read` | Identify the signed-in account. |
| `Directory.ReadWrite.All` | Read and change general directory objects. |
| `Application.ReadWrite.All` | Create and manage lab app registrations and enterprise applications. |
| `AppRoleAssignment.ReadWrite.All` | Grant the tenant runtime identity its reviewed broad application roles. |
| `Group.ReadWrite.All` | Create and manage lab groups and memberships. |
| `User.ReadWrite.All` | Create and manage simulated lab users. |
| `RoleManagement.ReadWrite.Directory` | Create and remove deliberate directory-role assignments. |
| `Policy.ReadWrite.ConditionalAccess` | Create and remove lab Conditional Access policies. |
| `AuditLog.Read.All` | Read directory and sign-in audit evidence. |
| `Reports.Read.All` | Read Microsoft 365 usage and security reports. |
| `Mail.ReadWrite` | Create and change mail the signed-in user can access. |
| `Mail.Send` | Generate mail activity as the signed-in user. |
| `Files.ReadWrite.All` | Create and change files the signed-in user can access. |
| `Sites.ReadWrite.All` | Create and change SharePoint content the signed-in user can access. |
| `SecurityEvents.ReadWrite.All` | Read and update security alerts available to the signed-in operator. |

| Azure permission | What After Party can explore |
| --- | --- |
| Azure Service Management `user_impersonation` | Inspect and manage Azure resources as the signed-in operator, bounded by that operator's Azure RBAC. |

To confirm the registration later:

```bash
az ad app show --id '9edaa951-658e-4be2-9623-ee906cb604b2' --query '{name:displayName, clientId:appId, audience:signInAudience, redirectUris:spa.redirectUris, permissions:requiredResourceAccess}' --output jsonc
```

The public, non-secret SPA settings live in [`site/app-config.js`](../site/app-config.js). The
published and local sites use the same client ID and select the appropriate registered redirect
URI. A client ID identifies the application; it is not a credential.

## Install it in a student tenant

The student installation does not create another app registration. A tenant administrator signs
in to the SPA, reviews the permission list, and approves it through Microsoft's tenant-specific
admin-consent page. Microsoft creates or updates the local **enterprise application** (service
principal) derived from the home-tenant application object.

The student tenant issues tokens for this local enterprise application. The tenant runtime uses the
shared application ID to identify that local object, but it does not contact or authenticate to the
application's home tenant. Downstream runtime work uses the separate managed identity installed in
the student tenant.

The SPA reports the tenant as connected only after Microsoft Graph confirms:

- exactly one enterprise application has the configured client ID, `After Party` name,
  `Application` type, and expected application home tenant;
- its tenant-wide delegated grant contains every reviewed permission; and
- it has no app-only role assignments.

The return is bound to the same browser session, account, and tenant that started approval. The
SPA retries briefly for normal Microsoft Graph propagation, and repeating approval updates the
same enterprise application rather than creating another one.

For development, the home-tenant application object and its derived local enterprise application
can and should coexist in the same tenant. The reconciliation command verifies and preserves the
enterprise application; it never requires uninstalling a valid local tenant installation merely to
update the home application object.

## Delete the application

1. Open [Azure Cloud Shell](https://shell.azure.com/) and select **Bash**.
2. Confirm that Cloud Shell is signed into the app registration's home tenant.
3. List every matching registration and copy the Application (client) ID of the one to delete:

   ```bash
   az ad app list --display-name 'After Party' --query '[].{name:displayName, clientId:appId, created:createdDateTime, audience:signInAudience}' --output table
   ```

   Microsoft Entra permits duplicate display names. If the command returns more than one row,
   identify the intended registration before continuing; the delete script deliberately does not
   select an application by name.

4. Review the pinned [delete script](https://github.com/seanewest/after-party-labs/blob/d987aaa661a9f7faed0ffa7ebd1be1b8ea068a17/scripts/delete-multitenant-app.sh),
   then paste this command into Cloud Shell:

   ```bash
   bash <(curl -fsSL 'https://raw.githubusercontent.com/seanewest/after-party-labs/d987aaa661a9f7faed0ffa7ebd1be1b8ea068a17/scripts/delete-multitenant-app.sh')
   ```

The script asks for the Application (client) ID, displays the registration it found, requires
the client ID again as confirmation, deletes the registration, and verifies that it is no longer
visible. This deletes the project-owned home-tenant registration.

## Uninstall it from a student tenant

Student uninstall removes the tenant-local enterprise application and its grants. It must not use
the developer teardown command above, which deletes the shared application registration.

Open a fresh Azure Cloud Shell in the student tenant, clone the repository, and check out the exact
commit shown by the published site's `version.json`. Replace `<deployed-commit>` below with that
full commit before running the uninstall script:

```bash
git clone 'https://github.com/seanewest/after-party-labs.git'
cd after-party-labs
git checkout --detach '<deployed-commit>'

AFTER_PARTY_APP_ID='9edaa951-658e-4be2-9623-ee906cb604b2' \
EXPECTED_TENANT_ID='<student-tenant-id>' \
CONFIRM_STUDENT_UNINSTALL='9edaa951-658e-4be2-9623-ee906cb604b2' \
bash scripts/uninstall-student-enterprise-app.sh
```

Verify that `git rev-parse HEAD` equals the published commit, then review
[`uninstall-student-enterprise-app.sh`](../scripts/uninstall-student-enterprise-app.sh) before
confirming the destructive action.

The script requires exactly one enterprise application with the expected client ID, developer
tenant, display name, and application type. It explicitly removes delegated grants and app-role
assignments, deletes only that service principal, and verifies its absence. If the student tenant
is also the application home tenant, it records the home application object's ID before uninstall
and verifies that the same registration still exists afterward.

The command is intentionally not idempotent after success: a second run stops because there is no
enterprise application to remove. Reconnect through the published SPA to create or reconcile the
same tenant-local enterprise application and grants again.

## Prove same-tenant connect, uninstall, and reconnect

This proof changes live Entra state. Obtain explicit human authorization before starting, use the
shared live-testing lock when one is available, and run it only in the isolated development tenant.
Do not preserve access tokens or full Graph responses as evidence.

1. Confirm the commit currently published by GitHub Pages:

   ```bash
   curl -fsSL 'https://seanewest.github.io/after-party-labs/version.json'
   ```

   Record the full `commit` value. The site footer must show the same value.

2. In Azure Cloud Shell, select the application home tenant and prove the home application object exists
   while the tenant-local enterprise application does not:

   ```bash
   az account show --query '{tenantId:tenantId,user:user.name}' --output table
   az ad app list --app-id '9edaa951-658e-4be2-9623-ee906cb604b2' \
     --query '[].{objectId:id,clientId:appId,name:displayName,audience:signInAudience}' --output table
   az ad sp list --filter "appId eq '9edaa951-658e-4be2-9623-ee906cb604b2'" \
     --query 'length(@)' --output tsv
   ```

   Stop unless the app query returns exactly the expected home application object and the service
   principal count is numeric zero. If a previous student installation exists, use the student
   uninstall command above only after its separate destructive action is authorized.

3. Open the [published SPA](https://seanewest.github.io/after-party-labs/), sign in with the
   development-tenant administrator, confirm the displayed tenant ID, review the permission list,
   and choose **Approve lab permissions**. Continue only when the SPA reports the same tenant as
   connected.

4. Independently prove that the original app registration and exactly one derived enterprise
   application coexist, that the tenant-wide delegated grant exists, and that no app-only grant
   exists:

   ```bash
   app_id='9edaa951-658e-4be2-9623-ee906cb604b2'
   az ad app list --app-id "$app_id" \
     --query '[].{objectId:id,clientId:appId,name:displayName,audience:signInAudience}' --output table
   az ad sp list --filter "appId eq '$app_id'" \
     --query '[].{objectId:id,clientId:appId,ownerTenant:appOwnerOrganizationId,name:displayName,type:servicePrincipalType}' \
     --output table
   sp_id="$(az ad sp list --filter "appId eq '$app_id'" --query '[0].id' --output tsv)"
   az rest --method GET \
     --url "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?\$filter=clientId%20eq%20%27${sp_id}%27&\$select=consentType,principalId,resourceId,scope" \
     --query 'value[].{consentType:consentType,principalId:principalId,resourceId:resourceId,scope:scope}' \
     --output table
   az rest --method GET \
     --url "https://graph.microsoft.com/v1.0/servicePrincipals/${sp_id}/appRoleAssignments?\$select=id" \
     --query 'length(value)' --output tsv
   ```

   The SPA performs the strict grant check; this independent output is sanitized corroborating
   evidence. The app-role assignment count must be numeric zero.

5. Run the student uninstall command above. Verify that it reports the original developer app
   registration object ID as preserved, then repeat the two `az ad app list` and `az ad sp list`
   checks from step 2. The registration must still be the same object and the service-principal
   count must be zero.

6. Repeat step 3, then step 4. Reconnection must reuse the home application object, create exactly
   one tenant-local enterprise application, restore the complete delegated grant, and return the
   SPA to the connected state.

Record only the deployed commit, tenant ID, developer application object ID, enterprise application
object IDs before uninstall and after reconnect, numeric counts, and the SPA's visible result. Do
not record tokens, browser storage, consent callback URLs, or unsanitized Graph responses.
