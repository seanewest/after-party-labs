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
  graph_applications_url='https://graph.microsoft.com/v1.0/applications'

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
    '{"displayName":"%s","signInAudience":"AzureADMultipleOrgs","spa":{"redirectUris":["%s"]},"web":{"homePageUrl":"%s"}}' \
    "$APP_DISPLAY_NAME" \
    "$SPA_REDIRECT_URI" \
    "$SPA_REDIRECT_URI")"

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
    actual_redirect_uri="$(
      az ad app show \
        --id "$created_app_id" \
        --query 'spa.redirectUris[0]' \
        --output tsv \
        --only-show-errors 2>/dev/null || true
    )"
    if [[ "$actual_audience" == 'AzureADMultipleOrgs' &&
          "$actual_redirect_uri" == "$SPA_REDIRECT_URI" ]]; then
      verified='true'
      break
    fi
    sleep 2
  done

  if [[ "$verified" != 'true' ]]; then
    echo 'The new app registration could not be verified with the requested settings.' >&2
    exit 1
  fi

  trap - EXIT

  printf 'Created and verified the multitenant app registration.\n'
  printf 'Display name: %s\n' "$APP_DISPLAY_NAME"
  printf 'Application (client) ID: %s\n' "$created_app_id"
  printf 'Home tenant ID: %s\n' "$tenant_id"
  printf 'SPA redirect URI: %s\n' "$SPA_REDIRECT_URI"
  printf 'Graph token expires: %s\n' "$token_expiry"
  printf '\nNo client secret or API permissions were created.\n'
  printf 'Save the application and tenant IDs for the delete script.\n'
)
