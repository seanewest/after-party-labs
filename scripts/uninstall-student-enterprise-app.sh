#!/usr/bin/env bash

# Remove only the tenant-local After Party enterprise application and its grants.
# This never deletes the developer-owned multitenant application registration.
#
# Non-interactive use:
#   AFTER_PARTY_APP_ID='9edaa951-658e-4be2-9623-ee906cb604b2' \
#   EXPECTED_TENANT_ID='92563293-315c-4b6c-9b90-bcb47ee8c970' \
#   CONFIRM_STUDENT_UNINSTALL='9edaa951-658e-4be2-9623-ee906cb604b2' \
#   bash scripts/uninstall-student-enterprise-app.sh
(
  set -euo pipefail

  readonly expected_display_name='After Party'
  readonly expected_developer_tenant_id='92563293-315c-4b6c-9b90-bcb47ee8c970'
  readonly graph_base_url='https://graph.microsoft.com/v1.0'
  readonly uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

  require_uuid() {
    local value="$1"
    local label="$2"
    if [[ ! "$value" =~ $uuid_pattern ]]; then
      printf '%s must be a UUID.\n' "$label" >&2
      exit 1
    fi
  }

  read_required_value() {
    local current_value="$1"
    local variable_name="$2"
    local prompt="$3"
    if [[ -n "$current_value" ]]; then
      printf '%s' "$current_value"
      return
    fi
    if [[ ! -t 0 ]]; then
      printf 'Set %s before running non-interactively.\n' "$variable_name" >&2
      exit 1
    fi
    local entered_value
    read -r -p "$prompt" entered_value
    printf '%s' "$entered_value"
  }

  graph_collection_ids() {
    local url="$1"
    az rest \
      --method GET \
      --url "$url" \
      --query 'value[].id' \
      --output tsv \
      --only-show-errors
  }

  wait_for_zero_count() {
    local description="$1"
    shift
    local count=''
    for _ in {1..15}; do
      if count="$("$@" 2>/dev/null)" && [[ "$count" =~ ^[0-9]+$ ]] && (( count == 0 )); then
        return 0
      fi
      sleep 2
    done
    printf '%s could not be verified as removed; last count was %s.\n' \
      "$description" "${count:-unavailable}" >&2
    return 1
  }

  if ! command -v az >/dev/null 2>&1; then
    echo 'Azure CLI (az) is required.' >&2
    exit 1
  fi

  app_id="$(read_required_value "${AFTER_PARTY_APP_ID:-}" 'AFTER_PARTY_APP_ID' 'After Party Application (client) ID: ')"
  expected_tenant_id="$(read_required_value "${EXPECTED_TENANT_ID:-}" 'EXPECTED_TENANT_ID' 'Student tenant ID: ')"
  require_uuid "$app_id" 'AFTER_PARTY_APP_ID'
  require_uuid "$expected_tenant_id" 'EXPECTED_TENANT_ID'

  if ! tenant_id="$(az account show --query tenantId --output tsv 2>/dev/null)" ||
     [[ -z "$tenant_id" ]]; then
    echo 'Azure CLI is not signed in. Refresh Cloud Shell or run az login, then retry.' >&2
    exit 1
  fi
  if [[ "$tenant_id" != "$expected_tenant_id" ]]; then
    echo "Signed into tenant $tenant_id, but EXPECTED_TENANT_ID is $expected_tenant_id." >&2
    echo 'No changes were made.' >&2
    exit 1
  fi
  if ! token_expiry="$(az account get-access-token --resource-type ms-graph --query expiresOn --output tsv 2>/dev/null)" ||
     [[ -z "$token_expiry" ]]; then
    echo 'The Azure CLI Microsoft Graph token cache is stale. Refresh Cloud Shell or run az login, then retry.' >&2
    exit 1
  fi

  app_registration_count="$(
    az ad app list --app-id "$app_id" --query 'length(@)' --output tsv --only-show-errors
  )"
  if [[ ! "$app_registration_count" =~ ^[01]$ ]]; then
    echo "Expected zero or one developer app registration for $app_id; found $app_registration_count." >&2
    echo 'No changes were made.' >&2
    exit 1
  fi
  app_registration_object_id=''
  if [[ "$app_registration_count" == '1' ]]; then
    app_registration_object_id="$(
      az ad app list --app-id "$app_id" --query '[0].id' --output tsv --only-show-errors
    )"
    actual_registration_app_id="$(
      az ad app list --app-id "$app_id" --query '[0].appId' --output tsv --only-show-errors
    )"
    actual_registration_name="$(
      az ad app list --app-id "$app_id" --query '[0].displayName' --output tsv --only-show-errors
    )"
    actual_registration_audience="$(
      az ad app list --app-id "$app_id" --query '[0].signInAudience' --output tsv --only-show-errors
    )"
    if [[ ! "$app_registration_object_id" =~ $uuid_pattern ||
          "$actual_registration_app_id" != "$app_id" ||
          "$actual_registration_name" != "$expected_display_name" ||
          "$actual_registration_audience" != 'AzureADMultipleOrgs' ]]; then
      echo 'The developer app registration did not match the expected After Party identity.' >&2
      echo 'No changes were made.' >&2
      exit 1
    fi
  fi

  service_principal_count="$(
    az ad sp list \
      --filter "appId eq '$app_id'" \
      --query 'length(@)' \
      --output tsv \
      --only-show-errors
  )"
  if [[ "$service_principal_count" != '1' ]]; then
    echo "Expected exactly one After Party enterprise application; found $service_principal_count." >&2
    echo 'No changes were made.' >&2
    exit 1
  fi

  service_principal_id="$(
    az ad sp list --filter "appId eq '$app_id'" --query '[0].id' --output tsv --only-show-errors
  )"
  actual_sp_app_id="$(
    az ad sp list --filter "appId eq '$app_id'" --query '[0].appId' --output tsv --only-show-errors
  )"
  actual_owner_tenant_id="$(
    az ad sp list --filter "appId eq '$app_id'" --query '[0].appOwnerOrganizationId' --output tsv --only-show-errors
  )"
  actual_sp_name="$(
    az ad sp list --filter "appId eq '$app_id'" --query '[0].displayName' --output tsv --only-show-errors
  )"
  actual_sp_type="$(
    az ad sp list --filter "appId eq '$app_id'" --query '[0].servicePrincipalType' --output tsv --only-show-errors
  )"
  if [[ ! "$service_principal_id" =~ $uuid_pattern ||
        "$actual_sp_app_id" != "$app_id" ||
        "$actual_owner_tenant_id" != "$expected_developer_tenant_id" ||
        "$actual_sp_name" != "$expected_display_name" ||
        "$actual_sp_type" != 'Application' ]]; then
    echo 'The enterprise application did not match the expected After Party identity.' >&2
    echo 'No changes were made.' >&2
    exit 1
  fi

  printf 'Student enterprise application selected for uninstall:\n'
  printf '  Tenant ID: %s\n' "$tenant_id"
  printf '  Application (client) ID: %s\n' "$app_id"
  printf '  Service principal object ID: %s\n' "$service_principal_id"
  if [[ "$app_registration_count" == '1' ]]; then
    printf '  Developer app registration to preserve: %s\n' "$app_registration_object_id"
  else
    printf '  Developer app registration in this tenant: none\n'
  fi

  confirmation="${CONFIRM_STUDENT_UNINSTALL:-}"
  if [[ "$confirmation" != "$app_id" ]]; then
    if [[ ! -t 0 ]]; then
      echo 'Set CONFIRM_STUDENT_UNINSTALL to the same client ID to authorize uninstall.' >&2
      exit 1
    fi
    read -r -p 'Re-enter the Application (client) ID to confirm student uninstall: ' confirmation
  fi
  if [[ "$confirmation" != "$app_id" ]]; then
    echo 'Confirmation did not match. No changes were made.' >&2
    exit 1
  fi

  encoded_grant_filter="clientId%20eq%20%27${service_principal_id}%27"
  grants_url="${graph_base_url}/oauth2PermissionGrants?\$filter=${encoded_grant_filter}&\$select=id"
  if ! serialized_grant_ids="$(graph_collection_ids "$grants_url")"; then
    echo 'The delegated grants could not be listed. No enterprise application was deleted.' >&2
    exit 1
  fi
  grant_ids=()
  if [[ -n "$serialized_grant_ids" ]]; then
    mapfile -t grant_ids <<<"$serialized_grant_ids"
  fi
  for grant_id in "${grant_ids[@]}"; do
    [[ -n "$grant_id" ]] || continue
    require_uuid "$grant_id" 'OAuth permission grant ID'
    az rest \
      --method DELETE \
      --url "${graph_base_url}/oauth2PermissionGrants/${grant_id}" \
      --only-show-errors >/dev/null
  done
  wait_for_zero_count \
    'OAuth permission grants' \
    az rest --method GET --url "$grants_url" --query 'length(value)' --output tsv --only-show-errors

  assignments_url="${graph_base_url}/servicePrincipals/${service_principal_id}/appRoleAssignments?\$select=id"
  if ! serialized_assignment_ids="$(graph_collection_ids "$assignments_url")"; then
    echo 'The app-role assignments could not be listed. No enterprise application was deleted.' >&2
    exit 1
  fi
  assignment_ids=()
  if [[ -n "$serialized_assignment_ids" ]]; then
    mapfile -t assignment_ids <<<"$serialized_assignment_ids"
  fi
  for assignment_id in "${assignment_ids[@]}"; do
    [[ -n "$assignment_id" ]] || continue
    require_uuid "$assignment_id" 'App role assignment ID'
    az rest \
      --method DELETE \
      --url "${graph_base_url}/servicePrincipals/${service_principal_id}/appRoleAssignments/${assignment_id}" \
      --only-show-errors >/dev/null
  done
  wait_for_zero_count \
    'App role assignments' \
    az rest --method GET --url "$assignments_url" --query 'length(value)' --output tsv --only-show-errors

  az ad sp delete --id "$service_principal_id" --only-show-errors
  wait_for_zero_count \
    'After Party enterprise applications' \
    az ad sp list --filter "appId eq '$app_id'" --query 'length(@)' --output tsv --only-show-errors

  remaining_registration_count="$(
    az ad app list --app-id "$app_id" --query 'length(@)' --output tsv --only-show-errors
  )"
  if [[ "$remaining_registration_count" != "$app_registration_count" ]]; then
    echo 'The developer app registration count changed unexpectedly after student uninstall.' >&2
    exit 1
  fi
  if [[ "$app_registration_count" == '1' ]]; then
    remaining_registration_object_id="$(
      az ad app list --app-id "$app_id" --query '[0].id' --output tsv --only-show-errors
    )"
    if [[ "$remaining_registration_object_id" != "$app_registration_object_id" ]]; then
      echo 'The developer app registration identity changed unexpectedly after student uninstall.' >&2
      exit 1
    fi
  fi

  printf 'Uninstalled and verified removal of the student enterprise application.\n'
  printf 'Revoked delegated grants: %s\n' "${#grant_ids[@]}"
  printf 'Revoked app-role assignments: %s\n' "${#assignment_ids[@]}"
  if [[ "$app_registration_count" == '1' ]]; then
    printf 'Preserved developer app registration: %s\n' "$app_registration_object_id"
  fi
  printf 'Graph token expires: %s\n' "$token_expiry"
)
