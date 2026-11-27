#!/usr/bin/env bash
# Read-only health, toolchain, listener, and isolation check for Linger
# verification. Delegates live Web stack checks to .agents/skills/verify-linger/scripts/doctor.sh
# and adds --preflight and --local-client checks.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=toolchain.sh
source "$script_dir/toolchain.sh"

mode="web"
with_connectors=0
installer_home=""

usage() {
  cat <<'EOF'
Usage: .claude/skills/verify/scripts/doctor.sh [--web [--with-connectors] | --local-client [--home <dir>] | --preflight]

Read-only diagnostic check for Linger verification:
  --web                 Check live isolated Web/TeamHub/Control/Runtime health and listeners via verify-linger doctor.sh (default).
  --with-connectors     With --web, also check the disposable Composio adapter endpoint.
  --local-client        Check Desktop/Local Installer toolchain and build; with --home <dir>, check that isolated installer instance.
  --preflight           Check toolchain, Docker daemon, Playwright Chromium, and default Web port availability before launch.
EOF
}

while (($# > 0)); do
  case "$1" in
    --web)
      mode="web"
      shift
      ;;
    --with-connectors)
      with_connectors=1
      shift
      ;;
    --local-client)
      mode="local-client"
      shift
      ;;
    --home)
      if (($# < 2)); then
        printf 'FAIL: --home requires a directory path.\n' >&2
        exit 2
      fi
      installer_home=$2
      shift 2
      ;;
    --preflight)
      mode="preflight"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'FAIL: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

verify_activate_toolchain

web_port=${PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT:-23008}
teamhub_port=${PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT:-28089}
control_port=${PLAYWRIGHT_ROOM_DOCUMENT_CONTROL_PORT:-28088}
runtime_port=${PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT:-24328}
composio_port=${VERIFY_COMPOSIO_PORT:-28087}

print_identity() {
  printf 'Checkout: %s\n' "$verify_repo_root"
  printf 'HEAD: %s\n' "$(git -C "$verify_repo_root" rev-parse --short HEAD)"
  printf 'Toolchain: node %s, pnpm %s, %s\n' \
    "$(node --version)" \
    "$(pnpm --version)" \
    "$(go version 2>/dev/null || printf 'go unavailable')"
}

run_preflight() {
  local failures=0
  print_identity

  if [[ ! -x "$verify_repo_root/node_modules/.bin/playwright" ]]; then
    printf 'FAIL: node_modules missing in this worktree; run pnpm install --frozen-lockfile --prefer-offline\n' >&2
    failures=$((failures + 1))
  else
    printf 'CHECK node_modules: OK\n'
  fi

  local chromium_path
  if chromium_path=$(cd "$verify_repo_root" && node -e 'const fs=require("fs"), pw=require("@playwright/test"); const p=pw.chromium.executablePath(); if (!fs.existsSync(p)) process.exit(1); console.log(p);' 2>/dev/null); then
    printf 'CHECK playwright chromium: OK (%s)\n' "$chromium_path"
  else
    printf 'FAIL: Playwright Chromium missing; run pnpm exec playwright install chromium\n' >&2
    failures=$((failures + 1))
  fi

  if docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
    printf 'CHECK docker daemon: OK (%s)\n' "$(docker info --format '{{.ServerVersion}}')"
  else
    printf 'FAIL: Docker daemon unreachable (required for isolated PostgreSQL in Web proofs)\n' >&2
    failures=$((failures + 1))
  fi

  local port
  for port in "$web_port" "$teamhub_port" "$control_port" "$runtime_port"; do
    if verify_assert_port_free "$port"; then
      printf 'CHECK port %s: FREE\n' "$port"
    else
      failures=$((failures + 1))
    fi
  done

  if ((failures > 0)); then
    printf 'Preflight failed with %d issue(s).\n' "$failures" >&2
    return 1
  fi
  printf 'Preflight passed (0 failures).\n'
}

run_web_doctor() {
  print_identity
  "$verify_repo_root/.agents/skills/verify-linger/scripts/doctor.sh"

  if ((with_connectors == 1)) || [[ ${VERIFY_CONNECTED_APPS:-0} == 1 ]] || [[ ${VERIFY_CONNECTOR_CLI:-0} == 1 ]]; then
    printf 'GET http://127.0.0.1:%s/healthz\n' "$composio_port"
    curl --noproxy '*' --fail --silent --show-error --max-time 5 "http://127.0.0.1:${composio_port}/healthz"
    printf '\n'
    local listeners
    listeners=$(verify_port_listeners "$composio_port")
    if [[ -z $listeners ]]; then
      printf 'FAIL: no listener on Composio adapter port %s\n' "$composio_port" >&2
      return 1
    fi
    printf 'Composio listener: %s\n' "$(printf '%s' "$listeners" | tr '\n' ' ')"
  fi
  printf 'Doctor passed (0 failures).\n'
}

run_local_client_doctor() {
  local failures=0
  print_identity

  local installer_entry="$verify_repo_root/apps/linger-installer/dist/installer.js"
  if [[ -f "$installer_entry" ]]; then
    printf 'CHECK installer bundle: OK (%s)\n' "$installer_entry"
  else
    printf 'WARN installer bundle not built yet: run pnpm --filter @linger/linger-installer build\n'
  fi

  if command -v python3 >/dev/null 2>&1; then
    printf 'CHECK python3: OK (%s)\n' "$(python3 --version 2>&1)"
  else
    printf 'FAIL: python3 not found (needed for Desktop packaging tests)\n' >&2
    failures=$((failures + 1))
  fi

  if [[ -n $installer_home ]]; then
    local resolved_home default_user_home
    resolved_home=$(cd "$installer_home" 2>/dev/null && pwd || printf '%s' "$installer_home")
    default_user_home="${HOME}/.linger"
    if [[ "$resolved_home" == "$default_user_home" || "$resolved_home" == "$HOME" ]]; then
      printf 'FAIL: refusing to target shared user home %s; pass a disposable temp --home\n' "$resolved_home" >&2
      return 2
    fi

    local installer_dir="$resolved_home/installer"
    local launch_file="$installer_dir/launch.html"
    if [[ ! -f "$launch_file" ]]; then
      printf 'FAIL: missing %s (installer not ready)\n' "$launch_file" >&2
      return 1
    fi

    local modes
    modes=$(node -e '
      const fs = require("fs");
      const dirMode = (fs.statSync(process.argv[1]).mode & 0o777).toString(8);
      const fileMode = (fs.statSync(process.argv[2]).mode & 0o777).toString(8);
      console.log(`${dirMode}/${fileMode}`);
      if (dirMode !== "700" || fileMode !== "600") process.exit(1);
    ' "$installer_dir" "$launch_file") || {
      printf 'FAIL: insecure installer permissions (%s), expected 700/600\n' "${modes:-unknown}" >&2
      failures=$((failures + 1))
    }
    printf 'CHECK private permissions: OK (%s)\n' "${modes:-unknown}"

    local origin port
    origin=$(node -e '
      const fs = require("fs");
      const html = fs.readFileSync(process.argv[1], "utf8");
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(html);
      if (!match) process.exit(1);
      console.log(match[0]);
    ' "$launch_file") || {
      printf 'FAIL: could not extract loopback origin from launch.html\n' >&2
      return 1
    }
    port=${origin##*:}
    printf 'CHECK loopback origin: %s\n' "$origin"

    local listeners
    listeners=$(verify_port_listeners "$port")
    if [[ -z $listeners ]]; then
      printf 'FAIL: no listener on installer port %s\n' "$port" >&2
      failures=$((failures + 1))
    else
      printf 'CHECK listener on port %s: %s\n' "$port" "$(printf '%s' "$listeners" | tr '\n' ' ')"
    fi

    # Unauthenticated GET /api/environment returns 401 without consuming the bootstrap token.
    local status
    status=$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "${origin}/api/environment" || printf '000')
    if [[ $status == "401" ]]; then
      printf 'CHECK auth guard GET %s/api/environment (unauthenticated): OK (HTTP 401)\n' "$origin"
    else
      printf 'FAIL: expected HTTP 401 on unauthenticated %s/api/environment, got %s\n' "$origin" "$status" >&2
      failures=$((failures + 1))
    fi
  fi

  if ((failures > 0)); then
    printf 'Doctor failed with %d failure(s).\n' "$failures" >&2
    return 1
  fi
  printf 'Doctor passed (0 failures).\n'
}

case "$mode" in
  preflight) run_preflight ;;
  web) run_web_doctor ;;
  local-client) run_local_client_doctor ;;
esac
