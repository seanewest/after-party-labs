#!/usr/bin/env bash

# Paste this entire file into Azure Cloud Shell (Bash), or run it as a script.
# Override either default before running, for example:
#   APP_DISPLAY_NAME='After Party' \
#   SPA_REDIRECT_URI='https://example.github.io/after-party/' \
#   bash scripts/create-multitenant-app.sh
(
  set -euo pipefail

  APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-After Party}"
  SPA_REDIRECT_URI="${SPA_REDIRECT_URI:-https://seanewest.github.io/after-party-labs/}"
  LOCAL_SPA_REDIRECT_URI='http://127.0.0.1:4173/'
  graph_applications_url='https://graph.microsoft.com/v1.0/applications'
  microsoft_graph_app_id='00000003-0000-0000-c000-000000000000'
  microsoft_graph_permission_names=(
    'User.Read'
    'Directory.ReadWrite.All'
    'Application.ReadWrite.All'
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

  resource_access=''
  for permission_id in "${microsoft_graph_permission_ids[@]}"; do
    if [[ -n "$resource_access" ]]; then
      resource_access+=','
    fi
    resource_access+="{\"id\":\"$permission_id\",\"type\":\"Scope\"}"
  done
  required_resource_access="[{\"resourceAppId\":\"$microsoft_graph_app_id\",\"resourceAccess\":[$resource_access]}]"
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

  if ! token_expiry="$(az account get-access-token --resource-type ms-graph --query expiresOn --output tsv 2>/dev/null)" ||
     [[ -z "$token_expiry" ]]; then
    echo 'The Azure CLI Microsoft Graph token cache is stale. Refresh Cloud Shell or run az login, then retry.' >&2
    exit 1
  fi

  existing_count="$(
    az ad app list \
      --display-name "$APP_DISPLAY_NAME" \
      --query 'length(@)' \
      --output tsv \
      --only-show-errors
  )"
  if (( existing_count > 0 )); then
    echo "An app registration named '$APP_DISPLAY_NAME' already exists in tenant $tenant_id." >&2
    echo 'No changes were made. Use a different APP_DISPLAY_NAME or inspect the existing registration.' >&2
    exit 1
  fi

  request_body="$(printf \
    '{"displayName":"%s","signInAudience":"AzureADMultipleOrgs","spa":{"redirectUris":["%s","%s"]},"web":{"homePageUrl":"%s"},"requiredResourceAccess":%s}' \
    "$APP_DISPLAY_NAME" \
    "$SPA_REDIRECT_URI" \
    "$LOCAL_SPA_REDIRECT_URI" \
    "$SPA_REDIRECT_URI" \
    "$required_resource_access")"

  created_app_id=''
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

  created_app_id="$(
    az rest \
      --method POST \
      --url "$graph_applications_url" \
      --headers 'Content-Type=application/json' \
      --body "$request_body" \
      --query appId \
      --output tsv \
      --only-show-errors
  )"

  verified='false'
  for _ in {1..10}; do
    actual_audience="$(
      az ad app show \
        --id "$created_app_id" \
        --query signInAudience \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_redirect_uris="$(
      az ad app show \
        --id "$created_app_id" \
        --query 'join(`,`, sort(spa.redirectUris))' \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    actual_permission_ids="$(
      az ad app show \
        --id "$created_app_id" \
        --query "join(',', sort(requiredResourceAccess[?resourceAppId == '$microsoft_graph_app_id'].resourceAccess[].id[]))" \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    if [[ "$actual_audience" == 'AzureADMultipleOrgs' &&
          "$actual_redirect_uris" == "$expected_redirect_uris" &&
          "$actual_permission_ids" == "$expected_permission_ids" ]]; then
      verified='true'
      break
    fi
    sleep 2
  done

  if [[ "$verified" != 'true' ]]; then
    echo 'The new app registration could not be verified with the requested settings.' >&2
    exit 1
  fi

  service_principal_count="$(
    az ad sp list \
      --filter "appId eq '$created_app_id'" \
      --query 'length(@)' \
      --output tsv \
      --only-show-errors
  )"
  if [[ ! "$service_principal_count" =~ ^[0-9]+$ || "$service_principal_count" != '0' ]]; then
    echo 'The app registration unexpectedly created a service principal; refusing to keep a partial student installation.' >&2
    exit 1
  fi

  trap - EXIT

  printf 'Created and verified the multitenant app registration.\n'
  printf 'Display name: %s\n' "$APP_DISPLAY_NAME"
  printf 'Application (client) ID: %s\n' "$created_app_id"
  printf 'Home tenant ID: %s\n' "$tenant_id"
  printf 'SPA redirect URI: %s\n' "$SPA_REDIRECT_URI"
  printf 'Local redirect URI: %s\n' "$LOCAL_SPA_REDIRECT_URI"
  printf 'Graph token expires: %s\n' "$token_expiry"
  printf '\nConfigured %s delegated Microsoft Graph permissions:\n' "${#microsoft_graph_permission_names[@]}"
  printf '  %s\n' "${microsoft_graph_permission_names[@]}"
  printf 'No client secret, certificate, or service principal was created.\n'
  printf 'Save the application and tenant IDs for the delete script.\n'
)
