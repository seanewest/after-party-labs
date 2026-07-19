#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local actual="$1"
  local expected="$2"
  [[ "$actual" == *"$expected"* ]] ||
    fail "expected output to contain: $expected"
}

assert_log_contains() {
  local expected="$1"
  grep -F -- "$expected" "$AZ_MOCK_LOG" >/dev/null ||
    fail "expected Azure CLI call containing: $expected"
}

assert_log_excludes() {
  local unexpected="$1"
  if grep -F -- "$unexpected" "$AZ_MOCK_LOG" >/dev/null; then
    fail "unexpected Azure CLI call containing: $unexpected"
  fi
}

shopt -s nullglob
scripts=(scripts/*.sh)
(( ${#scripts[@]} > 0 )) || fail 'no shell scripts found'

for script in "${scripts[@]}"; do
  bash -n "$script"
done
printf 'PASS: shell syntax\n'

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mock_bin="$test_root/bin"
mkdir -p "$mock_bin"
export AZ_MOCK_LOG="$test_root/az.log"

cat >"$mock_bin/az" <<'MOCK_AZ'
#!/usr/bin/env bash

set -euo pipefail
: "${AZ_MOCK_LOG:?AZ_MOCK_LOG is required}"

printf '%q ' "$@" >>"$AZ_MOCK_LOG"
printf '\n' >>"$AZ_MOCK_LOG"

query=''
previous=''
for argument in "$@"; do
  if [[ "$previous" == '--query' ]]; then
    query="$argument"
    break
  fi
  previous="$argument"
done

case "${1:-}:${2:-}:${3:-}" in
  account:show:*)
    printf '%s\n' "${AZ_MOCK_TENANT_ID:-22222222-2222-2222-2222-222222222222}"
    ;;
  account:get-access-token:*)
    printf '%s\n' '2099-01-01 00:00:00.000000'
    ;;
  ad:app:list)
    if [[ " $* " == *' --display-name '* ]]; then
      printf '%s\n' "${AZ_MOCK_EXISTING_COUNT:-0}"
    elif [[ " $* " == *' --app-id '* ]]; then
      printf '%s\n' "${AZ_MOCK_REMAINING_COUNT:-0}"
    else
      printf 'Unexpected az ad app list call\n' >&2
      exit 2
    fi
    ;;
  ad:app:show)
    case "$query" in
      displayName)
        printf '%s\n' 'After Party'
        ;;
      appId)
        printf '%s\n' "${AZ_MOCK_APP_ID:-11111111-1111-1111-1111-111111111111}"
        ;;
      signInAudience)
        printf '%s\n' 'AzureADMultipleOrgs'
        ;;
      'join(`,`, sort(spa.redirectUris))')
        printf '%s\n' "${AZ_MOCK_REDIRECT_URIS:-http://127.0.0.1:4173/,https://example.test/after-party/}"
        ;;
      *requiredResourceAccess*)
        printf '%s\n' "${AZ_MOCK_PERMISSION_IDS:-}"
        ;;
      *)
        printf 'Unexpected az ad app show query: %s\n' "$query" >&2
        exit 2
        ;;
    esac
    ;;
  ad:app:delete)
    ;;
  ad:sp:list)
    printf '%s\n' "${AZ_MOCK_SP_COUNT:-0}"
    ;;
  rest:*)
    printf '%s\n' "${AZ_MOCK_APP_ID:-11111111-1111-1111-1111-111111111111}"
    ;;
  *)
    printf 'Unexpected Azure CLI call: %s\n' "$*" >&2
    exit 2
    ;;
esac
MOCK_AZ
chmod +x "$mock_bin/az"

mock_path="$mock_bin:$PATH"
app_id='11111111-1111-1111-1111-111111111111'
tenant_id='22222222-2222-2222-2222-222222222222'
redirect_uri='https://example.test/after-party/'
permission_ids=(
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
permission_ids_csv="$(printf '%s\n' "${permission_ids[@]}" | sort | paste -sd, -)"
redirect_uris_csv="$(printf '%s\n' "$redirect_uri" 'http://127.0.0.1:4173/' | sort | paste -sd, -)"

: >"$AZ_MOCK_LOG"
create_output="$(
  env \
    PATH="$mock_path" \
    APP_DISPLAY_NAME='After Party CI' \
    SPA_REDIRECT_URI="$redirect_uri" \
    AZ_MOCK_PERMISSION_IDS="$permission_ids_csv" \
    AZ_MOCK_REDIRECT_URIS="$redirect_uris_csv" \
    bash scripts/create-multitenant-app.sh
)"
assert_contains "$create_output" 'Created and verified the multitenant app registration.'
assert_contains "$create_output" "Application (client) ID: $app_id"
assert_contains "$create_output" 'Configured 14 delegated Microsoft Graph permissions:'
assert_contains "$create_output" 'No client secret, certificate, or service principal was created.'
assert_log_contains 'rest --method POST'
assert_log_contains 'http://127.0.0.1:4173/'
for permission_id in "${permission_ids[@]}"; do
  assert_log_contains "$permission_id"
done
assert_log_contains "ad sp list --filter appId\\ eq\\ \\'$app_id\\'"
assert_log_excludes 'ad app delete'
printf 'PASS: create script success path\n'

: >"$AZ_MOCK_LOG"
if service_principal_output="$(
  env \
    PATH="$mock_path" \
    APP_DISPLAY_NAME='After Party CI' \
    SPA_REDIRECT_URI="$redirect_uri" \
    AZ_MOCK_PERMISSION_IDS="$permission_ids_csv" \
    AZ_MOCK_REDIRECT_URIS="$redirect_uris_csv" \
    AZ_MOCK_SP_COUNT=1 \
    bash scripts/create-multitenant-app.sh 2>&1
)"; then
  fail 'create script accepted an unexpected service principal'
fi
assert_contains "$service_principal_output" 'unexpectedly created a service principal'
assert_log_contains "ad app delete --id $app_id"
printf 'PASS: create script removes the registration when a service principal appears\n'

: >"$AZ_MOCK_LOG"
if invalid_redirect_output="$(
  env \
    PATH="$mock_path" \
    SPA_REDIRECT_URI='http://example.test/after-party/' \
    bash scripts/create-multitenant-app.sh 2>&1
)"; then
  fail 'create script accepted a non-HTTPS redirect URI'
fi
assert_contains "$invalid_redirect_output" 'SPA_REDIRECT_URI must be an HTTPS URL'
[[ ! -s "$AZ_MOCK_LOG" ]] || fail 'invalid redirect URI reached Azure CLI'
printf 'PASS: create script rejects unsafe redirect URI before Azure access\n'

: >"$AZ_MOCK_LOG"
if existing_app_output="$(
  env \
    PATH="$mock_path" \
    AZ_MOCK_EXISTING_COUNT=1 \
    bash scripts/create-multitenant-app.sh 2>&1
)"; then
  fail 'create script accepted a duplicate display name'
fi
assert_contains "$existing_app_output" "An app registration named 'After Party' already exists"
assert_log_excludes 'rest --method POST'
printf 'PASS: create script stops before mutation when the app already exists\n'

: >"$AZ_MOCK_LOG"
delete_output="$(
  env \
    PATH="$mock_path" \
    AFTER_PARTY_APP_ID="$app_id" \
    CONFIRM_DELETE="$app_id" \
    EXPECTED_TENANT_ID="$tenant_id" \
    bash scripts/delete-multitenant-app.sh
)"
assert_contains "$delete_output" "Deleted and verified removal of app registration $app_id."
assert_log_contains "ad app delete --id $app_id"
assert_log_contains "ad app list --app-id $app_id"
printf 'PASS: delete script success path\n'

: >"$AZ_MOCK_LOG"
if wrong_tenant_output="$(
  env \
    PATH="$mock_path" \
    AFTER_PARTY_APP_ID="$app_id" \
    CONFIRM_DELETE="$app_id" \
    EXPECTED_TENANT_ID='33333333-3333-3333-3333-333333333333' \
    bash scripts/delete-multitenant-app.sh 2>&1
)"; then
  fail 'delete script accepted the wrong tenant'
fi
assert_contains "$wrong_tenant_output" "Signed into tenant $tenant_id"
assert_log_excludes 'ad app show'
assert_log_excludes 'ad app delete'
printf 'PASS: delete script stops before lookup or mutation in the wrong tenant\n'

printf 'All shell script tests passed.\n'
