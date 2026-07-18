# Multitenant application

After Party uses a Microsoft Entra multitenant application as its shared sign-in and
installation entry point. The lifecycle scripts below are pinned to the tested script commit
[`bd931686cc7efcaacd42e26aa2b1ea37bcb43f29`](https://github.com/seanewest/after-party-labs/commit/bd931686cc7efcaacd42e26aa2b1ea37bcb43f29),
so the downloaded contents do not change when the repository branch moves.

## Create the application

1. Open [Azure Cloud Shell](https://shell.azure.com/) and select **Bash**.
2. Confirm that Cloud Shell is signed into the tenant that should own the app registration:

   ```bash
   az account show --query '{tenantId:tenantId, subscription:name, user:user.name}' --output table
   ```

3. Review the pinned [create script](https://github.com/seanewest/after-party-labs/blob/bd931686cc7efcaacd42e26aa2b1ea37bcb43f29/scripts/create-multitenant-app.sh),
   then paste this command into Cloud Shell:

   ```bash
   bash <(curl -fsSL 'https://raw.githubusercontent.com/seanewest/after-party-labs/bd931686cc7efcaacd42e26aa2b1ea37bcb43f29/scripts/create-multitenant-app.sh')
   ```

The script creates and verifies the registration, then prints its Application (client) ID and
home tenant ID. Save both values. It does not create a client secret or request API permissions.

To confirm the registration later:

```bash
az ad app list --display-name 'After Party' --query '[].{name:displayName, clientId:appId, audience:signInAudience, redirectUris:spa.redirectUris}' --output jsonc
```

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

4. Review the pinned [delete script](https://github.com/seanewest/after-party-labs/blob/bd931686cc7efcaacd42e26aa2b1ea37bcb43f29/scripts/delete-multitenant-app.sh),
   then paste this command into Cloud Shell:

   ```bash
   bash <(curl -fsSL 'https://raw.githubusercontent.com/seanewest/after-party-labs/bd931686cc7efcaacd42e26aa2b1ea37bcb43f29/scripts/delete-multitenant-app.sh')
   ```

The script asks for the Application (client) ID, displays the registration it found, requires
the client ID again as confirmation, deletes the registration, and verifies that it is no longer
visible.
