#!/usr/bin/env bash

# Paste this entire file into Azure Cloud Shell (Bash), or run it as a script.
# Override either default before running, for example:
#   APP_DISPLAY_NAME='After Party' \
#   SPA_REDIRECT_URI='https://example.github.io/after-party/' \
#   bash scripts/create-multitenant-app.sh
# To reconcile an existing registration, set AFTER_PARTY_APP_ID,
# EXPECTED_TENANT_ID, and CONFIRM_RECONCILE to the exact known values.
(
  set -euo pipefail

  APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-After Party}"
  SPA_REDIRECT_URI="${SPA_REDIRECT_URI:-https://seanewest.github.io/after-party-labs/}"
  AFTER_PARTY_APP_ID="${AFTER_PARTY_APP_ID:-}"
  EXPECTED_TENANT_ID="${EXPECTED_TENANT_ID:-}"
  CONFIRM_RECONCILE="${CONFIRM_RECONCILE:-}"
  LOCAL_SPA_REDIRECT_URI='http://127.0.0.1:4173/'
  graph_applications_url='https://graph.microsoft.com/v1.0/applications'
  microsoft_graph_app_id='00000003-0000-0000-c000-000000000000'
  azure_service_management_app_id='797f4846-ba00-4fd7-ba43-dac1f8f63013'
  azure_service_management_permission_id='41094075-9dad-400e-a0bd-54e686782033'
  runtime_api_scope_id='5c9bfc9c-4f2e-477d-a572-3d7fabe8542d'
  runtime_api_role_id='f2b4a169-9f29-48c3-b0db-8c5efc1b895b'
  runtime_api_scope_name='AfterParty.Operate'
  microsoft_graph_permission_names=(
    'User.Read'
    'Directory.ReadWrite.All'
    'Application.ReadWrite.All'
    'AppRoleAssignment.ReadWrite.All'
    'Group.ReadWrite.All'
    'User.ReadWrite.All'
    'RoleManagement.ReadWrite.Directory'
    'Policy.ReadWrite.ConditionalAccess'
    'AuditLog.Read.All'
    'Reports.Read.All'
    'Mail.ReadWrite'
    'Mail.Send'
    'Files.ReadWrite.All'
    'Sites.ReadWrite.All'
    'SecurityEvents.ReadWrite.All'
  )
  microsoft_graph_permission_ids=(
    'e1fe6dd8-ba31-4d61-89e7-88639da4683d'
    'c5366453-9fb0-48a5-a156-24f0c49a4b84'
    'bdfbf15f-ee85-4955-8675-146e8e5296b5'
    '84bccea3-f856-4a8a-967b-dbe0a3d53a64'
    '4e46008b-f24c-477d-8fff-7bb4ec7aafe0'
    '204e0828-b5ca-4ad8-b9f3-f32a958e7cc4'
    'd01b97e9-cbc0-49fe-810a-750afd5527a3'
    'ad902697-1014-4ef5-81ef-2b4301988e8c'
    'e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20'
    '02e97553-ed7b-43d0-ab3c-f8bace0d040c'
    '024d486e-b451-40bb-833d-3e66d98c5c73'
    'e383f46e-2787-4529-855e-0e479a3ffac0'
    '863451e7-0667-486c-a5d6-d135439485f0'
    '89fe6a52-be36-487e-b7d8-d061c450a026'
    '6aedf524-7e1c-45a7-bd76-ded8cab8d0fc'
  )

  if ! command -v az >/dev/null 2>&1; then
    echo 'Azure CLI (az) is required.' >&2
    exit 1
  fi

  display_name_pattern='^[[:alnum:]][[:alnum:] ._-]{0,119}$'
  if [[ ! "$APP_DISPLAY_NAME" =~ $display_name_pattern ]]; then
    echo 'APP_DISPLAY_NAME must be 1-120 letters, numbers, spaces, periods, underscores, or hyphens.' >&2
    exit 1
  fi

  if [[ "$SPA_REDIRECT_URI" != https://* ||
        "$SPA_REDIRECT_URI" == *'"'* ||
        "$SPA_REDIRECT_URI" == *'\'* ||
        "$SPA_REDIRECT_URI" == *$'\n'* ||
        "$SPA_REDIRECT_URI" == *$'\r'* ]]; then
    echo 'SPA_REDIRECT_URI must be an HTTPS URL without quotes, backslashes, or line breaks.' >&2
    exit 1
  fi

  uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  operation='create'
  if [[ -n "$AFTER_PARTY_APP_ID" || -n "$EXPECTED_TENANT_ID" || -n "$CONFIRM_RECONCILE" ]]; then
    operation='reconcile'
    if [[ ! "$AFTER_PARTY_APP_ID" =~ $uuid_pattern ]]; then
      echo 'AFTER_PARTY_APP_ID must be the existing application client ID in UUID form.' >&2
      exit 1
    fi
    if [[ ! "$EXPECTED_TENANT_ID" =~ $uuid_pattern ]]; then
      echo 'EXPECTED_TENANT_ID must be the existing application home tenant ID in UUID form.' >&2
      exit 1
    fi
    if [[ "$CONFIRM_RECONCILE" != "$AFTER_PARTY_APP_ID" ]]; then
      echo 'Set CONFIRM_RECONCILE to the same client ID to authorize reconciliation.' >&2
      exit 1
    fi
  fi

  resource_access=''
  for permission_id in "${microsoft_graph_permission_ids[@]}"; do
    if [[ -n "$resource_access" ]]; then
      resource_access+=','
    fi
    resource_access+="{\"id\":\"$permission_id\",\"type\":\"Scope\"}"
  done
  required_resource_access="[{\"resourceAppId\":\"$microsoft_graph_app_id\",\"resourceAccess\":[$resource_access]},{\"resourceAppId\":\"$azure_service_management_app_id\",\"resourceAccess\":[{\"id\":\"$azure_service_management_permission_id\",\"type\":\"Scope\"}]}]"
  expected_permission_ids="$(
    printf '%s\n' "${microsoft_graph_permission_ids[@]}" | sort | paste -sd, -
  )"
  expected_redirect_uris="$(
    printf '%s\n' "$SPA_REDIRECT_URI" "$LOCAL_SPA_REDIRECT_URI" | sort | paste -sd, -
  )"

  if ! tenant_id="$(az account show --query tenantId --output tsv 2>/dev/null)" || [[ -z "$tenant_id" ]]; then
    echo 'Azure CLI is not signed in. Refresh Cloud Shell or run az login, then retry.' >&2
    exit 1
  fi

  if [[ "$operation" == 'reconcile' && "$tenant_id" != "$EXPECTED_TENANT_ID" ]]; then
    echo "Signed into tenant $tenant_id, but expected application home tenant $EXPECTED_TENANT_ID." >&2
    echo 'No changes were made. Switch tenants and retry.' >&2
    exit 1
  fi

  if ! token_expiry="$(az account get-access-token --resource-type ms-graph --query expiresOn --output tsv 2>/dev/null)" ||
     [[ -z "$token_expiry" ]]; then
    echo 'The Azure CLI Microsoft Graph token cache is stale. Refresh Cloud Shell or run az login, then retry.' >&2
    exit 1
  fi

  create_request_body="$(printf \
    '{"displayName":"%s","signInAudience":"AzureADMultipleOrgs","spa":{"redirectUris":["%s","%s"]},"web":{"homePageUrl":"%s"},"requiredResourceAccess":%s}' \
    "$APP_DISPLAY_NAME" \
    "$SPA_REDIRECT_URI" \
    "$LOCAL_SPA_REDIRECT_URI" \
    "$SPA_REDIRECT_URI" \
    "$required_resource_access")"
  reconcile_request_body="$(printf \
    '{"signInAudience":"AzureADMultipleOrgs","spa":{"redirectUris":["%s","%s"]},"web":{"homePageUrl":"%s"},"requiredResourceAccess":%s}' \
    "$SPA_REDIRECT_URI" \
    "$LOCAL_SPA_REDIRECT_URI" \
    "$SPA_REDIRECT_URI" \
    "$required_resource_access")"

  created_app_id=''
  target_app_id=''
  target_object_id=''
  local_service_principal_id=''

  verify_optional_local_service_principal() {
    local app_id="$1"
    local expected_tenant_id="$2"
    local count
    local actual_app_id
    local actual_display_name
    local actual_owner_tenant_id
    local actual_type

    count="$(
      az ad sp list \
        --filter "appId eq '$app_id'" \
        --query 'length(@)' \
        --output tsv \
        --only-show-errors
    )"
    if [[ ! "$count" =~ ^[0-9]+$ || "$count" -gt 1 ]]; then
      echo "Expected at most one tenant-local enterprise application for client ID $app_id; found $count." >&2
      return 1
    fi
    if [[ "$count" == '0' ]]; then
      local_service_principal_id=''
      return 0
    fi

    local_service_principal_id="$(
      az ad sp list \
        --filter "appId eq '$app_id'" \
        --query '[0].id' \
        --output tsv \
        --only-show-errors
    )"
    actual_app_id="$(
      az ad sp list \
        --filter "appId eq '$app_id'" \
        --query '[0].appId' \
        --output tsv \
        --only-show-errors
    )"
    actual_owner_tenant_id="$(
      az ad sp list \
        --filter "appId eq '$app_id'" \
        --query '[0].appOwnerOrganizationId' \
        --output tsv \
        --only-show-errors
    )"
    actual_display_name="$(
      az ad sp list \
        --filter "appId eq '$app_id'" \
        --query '[0].displayName' \
        --output tsv \
        --only-show-errors
    )"
    actual_type="$(
      az ad sp list \
        --filter "appId eq '$app_id'" \
        --query '[0].servicePrincipalType' \
        --output tsv \
        --only-show-errors
    )"
    if [[ ! "$local_service_principal_id" =~ $uuid_pattern ||
          "$actual_app_id" != "$app_id" ||
          "$actual_owner_tenant_id" != "$expected_tenant_id" ||
          "$actual_display_name" != "$APP_DISPLAY_NAME" ||
          "$actual_type" != 'Application' ]]; then
      echo 'The tenant-local enterprise application does not match the home application object.' >&2
      return 1
    fi
  }

  cleanup_on_error() {
    status=$?
    trap - EXIT
    if (( status != 0 )) && [[ -n "$created_app_id" ]]; then
      echo "Creation did not complete; removing partial app registration $created_app_id." >&2
      az ad app delete --id "$created_app_id" --only-show-errors >/dev/null 2>&1 ||
        echo "Automatic cleanup failed. Delete app registration $created_app_id manually." >&2
    fi
    exit "$status"
  }
  trap cleanup_on_error EXIT

  if [[ "$operation" == 'create' ]]; then
    existing_count="$(
      az ad app list \
        --display-name "$APP_DISPLAY_NAME" \
        --query 'length(@)' \
        --output tsv \
        --only-show-errors
    )"
    if (( existing_count > 0 )); then
      echo "An app registration named '$APP_DISPLAY_NAME' already exists in tenant $tenant_id." >&2
      echo 'No changes were made. Use the exact-ID reconciliation mode or a different APP_DISPLAY_NAME.' >&2
      exit 1
    fi

    created_app_id="$(
      az rest \
        --method POST \
        --url "$graph_applications_url" \
        --headers 'Content-Type=application/json' \
        --body "$create_request_body" \
        --query appId \
        --output tsv \
        --only-show-errors
    )"
    target_app_id="$created_app_id"
  else
    existing_app_id="$(
      az ad app show \
        --id "$AFTER_PARTY_APP_ID" \
        --query appId \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    existing_display_name="$(
      az ad app show \
        --id "$AFTER_PARTY_APP_ID" \
        --query displayName \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    existing_object_id="$(
      az ad app show \
        --id "$AFTER_PARTY_APP_ID" \
        --query id \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    if [[ "$existing_app_id" != "$AFTER_PARTY_APP_ID" ||
          "$existing_display_name" != "$APP_DISPLAY_NAME" ||
          ! "$existing_object_id" =~ $uuid_pattern ]]; then
      echo "Client ID $AFTER_PARTY_APP_ID did not resolve to the expected '$APP_DISPLAY_NAME' application." >&2
      echo 'No changes were made.' >&2
      exit 1
    fi

    if ! verify_optional_local_service_principal "$AFTER_PARTY_APP_ID" "$tenant_id"; then
      echo 'No changes were made.' >&2
      exit 1
    fi

    az rest \
      --method PATCH \
      --url "$graph_applications_url/$existing_object_id" \
      --headers 'Content-Type=application/json' \
      --body "$reconcile_request_body" \
      --only-show-errors >/dev/null
    target_app_id="$AFTER_PARTY_APP_ID"
    target_object_id="$existing_object_id"
  fi

  if [[ -z "$target_object_id" ]]; then
    target_object_id="$(
      az ad app show --id "$target_app_id" --query id --output tsv --only-show-errors
    )"
  fi
  if [[ ! "$target_object_id" =~ $uuid_pattern ]]; then
    echo 'The created application object ID could not be verified.' >&2
    exit 1
  fi

  runtime_api_request_body="$(printf \
    '{"identifierUris":["api://%s"],"api":{"requestedAccessTokenVersion":2,"oauth2PermissionScopes":[{"adminConsentDescription":"Allow the After Party SPA to call the matching tenant runtime as the signed-in operator.","adminConsentDisplayName":"Operate the After Party tenant runtime","id":"%s","isEnabled":true,"type":"Admin","userConsentDescription":null,"userConsentDisplayName":null,"value":"%s"}],"preAuthorizedApplications":[{"appId":"%s","delegatedPermissionIds":["%s"]}]},"appRoles":[{"allowedMemberTypes":["Application"],"description":"Allow the tenant runtime identity and its federated GitHub workflow to call the matching After Party API.","displayName":"Operate the After Party tenant runtime","id":"%s","isEnabled":true,"origin":"Application","value":"%s"}]}' \
    "$target_app_id" \
    "$runtime_api_scope_id" \
    "$runtime_api_scope_name" \
    "$target_app_id" \
    "$runtime_api_scope_id" \
    "$runtime_api_role_id" \
    "$runtime_api_scope_name")"
  az rest \
    --method PATCH \
    --url "$graph_applications_url/$target_object_id" \
    --headers 'Content-Type=application/json' \
    --body "$runtime_api_request_body" \
    --only-show-errors >/dev/null

  verified='false'
  for _ in {1..10}; do
    actual_audience="$(
      az ad app show \
        --id "$target_app_id" \
        --query signInAudience \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_redirect_uris="$(
      az ad app show \
        --id "$target_app_id" \
        --query 'join(`,`, sort(spa.redirectUris))' \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_permission_ids="$(
      az ad app show \
        --id "$target_app_id" \
        --query "join(',', sort(requiredResourceAccess[?resourceAppId == '$microsoft_graph_app_id'].resourceAccess[].id[]))" \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_azure_management_permission_ids="$(
      az ad app show \
        --id "$target_app_id" \
        --query "join(',', sort(requiredResourceAccess[?resourceAppId == '$azure_service_management_app_id'].resourceAccess[].id[]))" \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_identifier_uri="$(
      az ad app show \
        --id "$target_app_id" \
        --query 'identifierUris[0]' \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_token_version="$(
      az ad app show \
        --id "$target_app_id" \
        --query 'api.requestedAccessTokenVersion' \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_runtime_scope_id="$(
      az ad app show \
        --id "$target_app_id" \
        --query "api.oauth2PermissionScopes[?value == '$runtime_api_scope_name' && isEnabled].id | [0]" \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_preauthorized_scope_id="$(
      az ad app show \
        --id "$target_app_id" \
        --query "api.preAuthorizedApplications[?appId == '$target_app_id'].delegatedPermissionIds[0] | [0]" \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_runtime_role_id="$(
      az ad app show \
        --id "$target_app_id" \
        --query "appRoles[?value == '$runtime_api_scope_name' && isEnabled && contains(allowedMemberTypes, 'Application')].id | [0]" \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    if [[ "$actual_audience" == 'AzureADMultipleOrgs' &&
          "$actual_redirect_uris" == "$expected_redirect_uris" &&
          "$actual_permission_ids" == "$expected_permission_ids" &&
          "$actual_azure_management_permission_ids" == "$azure_service_management_permission_id" &&
          "$actual_identifier_uri" == "api://$target_app_id" &&
          "$actual_token_version" == '2' &&
          "$actual_runtime_scope_id" == "$runtime_api_scope_id" &&
          "$actual_preauthorized_scope_id" == "$runtime_api_scope_id" &&
          "$actual_runtime_role_id" == "$runtime_api_role_id" ]]; then
      verified='true'
      break
    fi
    sleep 2
  done

  if [[ "$verified" != 'true' ]]; then
    echo 'The app registration could not be verified with the requested settings.' >&2
    exit 1
  fi

  if [[ "$operation" == 'create' ]]; then
    service_principal_count="$(
      az ad sp list \
        --filter "appId eq '$target_app_id'" \
        --query 'length(@)' \
        --output tsv \
        --only-show-errors
    )"
    if [[ ! "$service_principal_count" =~ ^[0-9]+$ || "$service_principal_count" != '0' ]]; then
      echo 'The app registration unexpectedly created a service principal; refusing to keep a partial student installation.' >&2
      exit 1
    fi
  elif ! verify_optional_local_service_principal "$target_app_id" "$tenant_id"; then
    echo 'The home application was changed, but its tenant-local enterprise application no longer matches. Reconcile the tenant installation before continuing.' >&2
    exit 1
  fi

  trap - EXIT

  if [[ "$operation" == 'create' ]]; then
    printf 'Created and verified the multitenant app registration.\n'
  else
    printf 'Reconciled and verified the existing multitenant app registration.\n'
  fi
  printf 'Display name: %s\n' "$APP_DISPLAY_NAME"
  printf 'Application (client) ID: %s\n' "$target_app_id"
  printf 'Home tenant ID: %s\n' "$tenant_id"
  printf 'SPA redirect URI: %s\n' "$SPA_REDIRECT_URI"
  printf 'Local redirect URI: %s\n' "$LOCAL_SPA_REDIRECT_URI"
  printf 'Runtime API scope: api://%s/%s\n' "$target_app_id" "$runtime_api_scope_name"
  printf 'Graph token expires: %s\n' "$token_expiry"
  printf '\nConfigured %s delegated Microsoft Graph permissions:\n' "${#microsoft_graph_permission_names[@]}"
  printf '  %s\n' "${microsoft_graph_permission_names[@]}"
  printf 'Configured delegated Azure management permission:\n'
  printf '  Azure Service Management / user_impersonation\n'
  if [[ -n "$local_service_principal_id" ]]; then
    printf 'Tenant-local enterprise application preserved: %s\n' "$local_service_principal_id"
    printf 'No client secret, certificate, or service principal was created or deleted.\n'
  else
    printf 'No client secret, certificate, or service principal was created.\n'
  fi
  printf 'Save the application and tenant IDs for the delete script.\n'
)
