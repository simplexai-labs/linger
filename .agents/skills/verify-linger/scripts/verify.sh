#!/usr/bin/env bash
set -euo pipefail
umask 077
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
cd "$repo"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 26 || minor < 5) throw Error("Use Node >=26.5.0 <27");'
if [[ -n ${TEST_DATABASE_URL:-} || ${PLAYWRIGHT_SKIP_WEB_SERVER:-0} == 1 ]]; then
  printf 'Refusing an external database or shared Web server.\n' >&2
  exit 2
fi
for binary in ROOM_DOCUMENT_E2E_MIGRATE_BINARY ROOM_DOCUMENT_E2E_DEMO_SEED_BINARY ROOM_DOCUMENT_E2E_TEAMHUB_BINARY; do
  if [[ -n ${!binary:-} ]]; then
    printf 'Unset %s so verification runs current-checkout source.\n' "$binary" >&2
    exit 2
  fi
done
export PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT=${PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT:-23008}
export PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT=${PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT:-28089}
export PLAYWRIGHT_ROOM_DOCUMENT_CONTROL_PORT=${PLAYWRIGHT_ROOM_DOCUMENT_CONTROL_PORT:-28088}
export PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT=${PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT:-24328}
export PLAYWRIGHT_ROOM_DOCUMENT_POSTGRES_PORT=0
export TEAMHUB_TEST_DATABASE=isolated
mkdir -p .cache
if command -v flock >/dev/null; then
  exec 9>.cache/verify-linger.lock
  flock -n 9 || { printf 'Another verification owns this checkout.\n' >&2; exit 2; }
else
  mkdir .cache/verify-linger.lockdir 2>/dev/null || { printf 'Another verification owns this checkout.\n' >&2; exit 2; }
  trap 'rmdir .cache/verify-linger.lockdir' EXIT
fi
for port in "$PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT" "$PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT" "$PLAYWRIGHT_ROOM_DOCUMENT_CONTROL_PORT" "$PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT" ${VERIFY_CONNECTED_APPS:+${VERIFY_COMPOSIO_PORT:-28087}} ${VERIFY_CONNECTOR_CLI:+${VERIFY_COMPOSIO_PORT:-28087}}; do
  if [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
    printf 'Invalid verification port: %s\n' "$port" >&2
    exit 2
  fi
  if { command -v ss >/dev/null && [[ -n $(ss -H -ltn "sport = :$port") ]]; } || { ! command -v ss >/dev/null && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null; }; then
    printf 'Port %s is already owned; choose a different port.\n' "$port" >&2
    exit 2
  fi
done
mkdir -p test-results/verify-linger
export VERIFY_LINGER_EVIDENCE
VERIFY_LINGER_EVIDENCE=$(mktemp -d "$repo/test-results/verify-linger/run.XXXXXX")
printf 'Evidence: %s\n' "$VERIFY_LINGER_EVIDENCE"
{
  git rev-parse HEAD
  git status --short
  node --version
  pnpm --version
  printf 'TEAMHUB_TEST_DATABASE=%s\n' "$TEAMHUB_TEST_DATABASE"
  printf 'VERIFY_CONNECTED_APPS=%s VERIFY_CONNECTOR_CLI=%s VERIFY_ROOM_STARTUP=%s VERIFY_ROOM_STARTUP_PRODUCTION=%s\n' \
    "${VERIFY_CONNECTED_APPS:-0}" "${VERIFY_CONNECTOR_CLI:-0}" "${VERIFY_ROOM_STARTUP:-0}" "${VERIFY_ROOM_STARTUP_PRODUCTION:-0}"
  if [[ -n ${VERIFY_CONNECTED_APPS:-} || -n ${VERIFY_CONNECTOR_CLI:-} ]]; then
    printf 'VERIFY_COMPOSIO_PORT=%s\n' "${VERIFY_COMPOSIO_PORT:-28087}"
  fi
  env | LC_ALL=C sort | sed -n '/^PLAYWRIGHT_ROOM_DOCUMENT_.*_PORT=/p'
} > "$VERIFY_LINGER_EVIDENCE/source.txt"
git diff --no-ext-diff HEAD > "$VERIFY_LINGER_EVIDENCE/source.patch"
{
  git diff --name-only --diff-filter=d -z HEAD
  git ls-files -z --others --exclude-standard
} | while IFS= read -r -d '' changed_file; do
  if command -v shasum >/dev/null; then
    shasum -a 256 "$changed_file"
  else
    sha256sum "$changed_file"
  fi
done > "$VERIFY_LINGER_EVIDENCE/changed-files.sha256"
set +e
pnpm exec playwright test --config .agents/skills/verify-linger/playwright.config.ts "$@" 2>&1 | tee "$VERIFY_LINGER_EVIDENCE/run.log"
result=${PIPESTATUS[0]}
set -e
printf '%s\n' "$result" > "$VERIFY_LINGER_EVIDENCE/exit-code.txt"
printf 'Evidence retained: %s\n' "$VERIFY_LINGER_EVIDENCE"
exit "$result"
