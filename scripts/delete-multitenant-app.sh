#!/usr/bin/env bash

# Paste this entire file into Azure Cloud Shell (Bash), or run it as a script.
# Provide the Application (client) ID printed by the create script:
#   AFTER_PARTY_APP_ID='00000000-0000-0000-0000-000000000000' \
#   bash scripts/delete-multitenant-app.sh
# For non-interactive use, also set CONFIRM_DELETE to the same client ID.
(
  set -euo pipefail

  if ! command -v az >/dev/null 2>&1; then
    echo 'Azure CLI (az) is required.' >&2
    exit 1
  fi

  if ! tenant_id="$(az account show --query tenantId --output tsv 2>/dev/null)" || [[ -z "$tenant_id" ]]; then
    echo 'Azure CLI is not signed in. Refresh Cloud Shell or run az login, then retry.' >&2
    exit 1
  fi

  if ! token_expiry="$(az account get-access-token --resource-type ms-graph --query expiresOn --output tsv 2>/dev/null)" ||
     [[ -z "$token_expiry" ]]; then
    echo 'The Azure CLI Microsoft Graph token cache is stale. Refresh Cloud Shell or run az login, then retry.' >&2
    exit 1
  fi

  app_id="${AFTER_PARTY_APP_ID:-}"
  if [[ -z "$app_id" ]]; then
    if [[ ! -t 0 ]]; then
      echo 'Set AFTER_PARTY_APP_ID to the Application (client) ID to delete.' >&2
      exit 1
    fi
    read -r -p 'Application (client) ID to delete: ' app_id
  fi

  uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  if [[ ! "$app_id" =~ $uuid_pattern ]]; then
    echo 'AFTER_PARTY_APP_ID must be a UUID Application (client) ID.' >&2
    exit 1
  fi

  if [[ -n "${EXPECTED_TENANT_ID:-}" && "$tenant_id" != "$EXPECTED_TENANT_ID" ]]; then
    echo "Signed into tenant $tenant_id, but EXPECTED_TENANT_ID is $EXPECTED_TENANT_ID." >&2
    echo 'No changes were made.' >&2
    exit 1
  fi

  if ! display_name="$(
    az ad app show \
      --id "$app_id" \
      --query displayName \
      --output tsv \
      --only-show-errors 2>/dev/null
  )" ||
     ! actual_app_id="$(
       az ad app show \
         --id "$app_id" \
         --query appId \
         --output tsv \
         --only-show-errors 2>/dev/null
     )" ||
     ! sign_in_audience="$(
       az ad app show \
         --id "$app_id" \
         --query signInAudience \
         --output tsv \
         --only-show-errors 2>/dev/null
     )"; then
    echo "App registration $app_id was not found in tenant $tenant_id." >&2
    exit 1
  fi

  if [[ "$actual_app_id" != "$app_id" ]]; then
    echo 'Azure returned an unexpected application ID. No changes were made.' >&2
    exit 1
  fi

  printf 'App registration selected for deletion:\n'
  printf '  Display name: %s\n' "$display_name"
  printf '  Application (client) ID: %s\n' "$app_id"
  printf '  Sign-in audience: %s\n' "$sign_in_audience"
  printf '  Home tenant ID: %s\n' "$tenant_id"

  confirmation="${CONFIRM_DELETE:-}"
  if [[ "$confirmation" != "$app_id" ]]; then
    if [[ ! -t 0 ]]; then
      echo 'Set CONFIRM_DELETE to the same client ID to authorize deletion.' >&2
      exit 1
    fi
    read -r -p 'Re-enter the Application (client) ID to confirm deletion: ' confirmation
  fi
  if [[ "$confirmation" != "$app_id" ]]; then
    echo 'Confirmation did not match. No changes were made.' >&2
    exit 1
  fi

  az ad app delete --id "$app_id" --only-show-errors

  last_verification_error=''
  for _ in {1..15}; do
    if remaining_count="$(
      az ad app list \
        --app-id "$app_id" \
        --query 'length(@)' \
        --output tsv \
        --only-show-errors 2>&1
    )"; then
      if [[ "$remaining_count" =~ ^[0-9]+$ ]]; then
        last_verification_error=''
        if (( remaining_count == 0 )); then
          printf 'Deleted and verified removal of app registration %s.\n' "$app_id"
          printf 'Graph token expires: %s\n' "$token_expiry"
          exit 0
        fi
      else
        last_verification_error="Azure CLI returned an unexpected count: $remaining_count"
      fi
    else
      last_verification_error="$remaining_count"
    fi
    sleep 2
  done

  if [[ -n "$last_verification_error" ]]; then
    echo "Deletion was requested, but removal could not be verified because the Azure query continued to fail." >&2
    echo "Last verification error: $last_verification_error" >&2
  else
    echo "Deletion was requested, but app registration $app_id is still visible after 30 seconds." >&2
  fi
  exit 1
)
