#!/usr/bin/env bash
# Activates the pinned Node/pnpm toolchain, maps a user-facing --journey or
# --spec selection onto the canonical verify-linger runner, and delegates all
# isolation, locking, port checks, and evidence capture to
# .agents/skills/verify-linger/scripts/verify.sh.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=toolchain.sh
source "$script_dir/toolchain.sh"
verify_activate_toolchain

journey="document"
custom_spec=""
passthrough_args=()

usage() {
  cat <<'EOF'
Usage: .claude/skills/verify/scripts/verify-web.sh [--journey <name> | --spec <path>] [-- <playwright-args...>]

Journeys:
  document            Native Room Document edit, save, and fresh-session persistence (default).
  login               Cookie session login, return_to redirect, logout reload guard, wrong password alert.
  rooms               Two-step Room creation, member add, leave/rejoin, frozen share/revoke, Room deletion.
  routines            Agent weekly routine create, fresh-session edit, and occurrence fire.
  connectors          Connected Apps category filter, mobile layout, disposable provider OAuth, disconnect.
  startup             Room startup responsiveness under held auxiliary responses.
  startup-production  Production-bundle startup latency measurement against real services.

Options:
  --spec <path>       Run a specific Playwright spec under apps/web/e2e/ via verify-linger.
  --headed, --debug, -g <pattern>, etc. are forwarded to Playwright.
EOF
}

while (($# > 0)); do
  case "$1" in
    --journey)
      if (($# < 2)); then
        printf 'FAIL: --journey requires a value.\n' >&2
        exit 2
      fi
      journey=$2
      custom_spec=""
      shift 2
      ;;
    --spec)
      if (($# < 2)); then
        printf 'FAIL: --spec requires a path.\n' >&2
        exit 2
      fi
      custom_spec=$2
      journey="custom"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      passthrough_args+=("$@")
      break
      ;;
    *)
      passthrough_args+=("$1")
      shift
      ;;
  esac
done

unset VERIFY_CONNECTED_APPS VERIFY_CONNECTOR_CLI VERIFY_ROOM_STARTUP VERIFY_ROOM_STARTUP_PRODUCTION VERIFY_SPEC

case "$journey" in
  document) ;;
  connectors)
    export VERIFY_CONNECTED_APPS=1
    ;;
  startup)
    export VERIFY_ROOM_STARTUP=1
    ;;
  startup-production)
    export VERIFY_ROOM_STARTUP_PRODUCTION=1
    ;;
  login)
    export VERIFY_SPEC="room-login-chain.spec.ts"
    ;;
  rooms)
    export VERIFY_SPEC="room-creation.spec.ts"
    ;;
  routines)
    export VERIFY_SPEC="room-routines.spec.ts"
    ;;
  custom)
    normalized=${custom_spec#apps/web/e2e/}
    if [[ ! -f "$verify_repo_root/apps/web/e2e/$normalized" ]]; then
      printf 'FAIL: spec not found under apps/web/e2e/: %s\n' "$custom_spec" >&2
      exit 2
    fi
    export VERIFY_SPEC="$normalized"
    ;;
  *)
    printf 'FAIL: unknown journey: %s\n' "$journey" >&2
    usage >&2
    exit 2
    ;;
esac

exec "$verify_repo_root/.agents/skills/verify-linger/scripts/verify.sh" "${passthrough_args[@]}"
