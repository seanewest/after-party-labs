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
      'spa.redirectUris[0]')
        printf '%s\n' "${SPA_REDIRECT_URI:-https://example.test/after-party/}"
        ;;
      *)
        printf 'Unexpected az ad app show query: %s\n' "$query" >&2
        exit 2
        ;;
    esac
    ;;
  ad:app:delete)
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

: >"$AZ_MOCK_LOG"
create_output="$(
  env \
    PATH="$mock_path" \
    APP_DISPLAY_NAME='After Party CI' \
    SPA_REDIRECT_URI="$redirect_uri" \
    bash scripts/create-multitenant-app.sh
)"
assert_contains "$create_output" 'Created and verified the multitenant app registration.'
assert_contains "$create_output" "Application (client) ID: $app_id"
assert_log_contains 'rest --method POST'
assert_log_excludes 'ad app delete'
printf 'PASS: create script success path\n'

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
