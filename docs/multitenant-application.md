# Multitenant application

After Party uses a Microsoft Entra multitenant application as its shared sign-in and
installation entry point. This is the developer-owned application registration. A student's
enterprise application is created later, in the student's tenant, when they approve After Party.

The setup below creates only the developer registration. It does not create a client secret,
certificate, service principal, or permission grant. The downloaded scripts are pinned to
reviewed commits so their contents do not change when the repository branch moves.

## Create the application

1. Open [Azure Cloud Shell](https://shell.azure.com/) and select **Bash**.
2. Confirm that Cloud Shell is signed into the tenant that should own the app registration:

   ```bash
   az account show --query '{tenantId:tenantId, subscription:name, user:user.name}' --output table
   ```

3. Review the pinned [create script](https://github.com/seanewest/after-party-labs/blob/30e9d29a10c24080f44ec19da41381e3adb63df7/scripts/create-multitenant-app.sh),
   then paste this command into Cloud Shell:

   ```bash
   bash <(curl -fsSL 'https://raw.githubusercontent.com/seanewest/after-party-labs/30e9d29a10c24080f44ec19da41381e3adb63df7/scripts/create-multitenant-app.sh')
   ```

The script creates and verifies the registration, then prints its Application (client) ID and
home tenant ID. Save both values. It also configures the production and local SPA redirect URIs
and the delegated Microsoft Graph permissions listed below.

## Permission boundary

These permissions are intentionally broad while After Party is being explored. They are suitable
only for an isolated lab tenant controlled by the student or developer. They are delegated
permissions: work is performed in the context of a signed-in user and remains limited by that
user's access. They are not app-only permissions for unattended runtime jobs.

Adding a permission to the developer registration does not grant it in a student tenant. The
student installation flow must show the requested access and obtain the appropriate consent.

| Microsoft Graph permission | What After Party can explore |
| --- | --- |
| `User.Read` | Identify the signed-in account. |
| `Directory.ReadWrite.All` | Read and change general directory objects. |
| `Application.ReadWrite.All` | Create and manage lab app registrations and enterprise applications. |
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

To confirm the registration later:

```bash
az ad app show --id '9edaa951-658e-4be2-9623-ee906cb604b2' --query '{name:displayName, clientId:appId, audience:signInAudience, redirectUris:spa.redirectUris, permissions:requiredResourceAccess}' --output jsonc
```

The public, non-secret SPA settings live in [`site/app-config.js`](../site/app-config.js). The
published and local sites use the same client ID and select the appropriate registered redirect
URI. A client ID identifies the application; it is not a credential.

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
visible. This deletes the developer-owned registration. Removing a student's enterprise
application is a separate student-tenant operation.
