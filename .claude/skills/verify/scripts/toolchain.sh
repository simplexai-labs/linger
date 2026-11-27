#!/usr/bin/env bash
# Sourced by .claude/skills/verify/scripts/* to activate the pinned Node and
# pnpm versions from .node-version and package.json without touching user shims.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'Source this script instead of executing it: source %s\n' "$0" >&2
  exit 2
fi

verify_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)

verify_activate_toolchain() {
  local required_node required_major required_minor required_pnpm
  local current_node current_major current_minor current_pnpm
  local mise_node_dir mise_pnpm_dir

  required_node=$(tr -d '[:space:]' <"$verify_repo_root/.node-version")
  required_major=${required_node%%.*}
  required_minor=${required_node#*.}
  required_minor=${required_minor%%.*}
  required_pnpm=$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' "$verify_repo_root/package.json" | head -n 1)

  current_node=$(node -p 'process.versions.node' 2>/dev/null || true)
  current_major=${current_node%%.*}
  current_minor=${current_node#*.}
  current_minor=${current_minor%%.*}

  if [[ -z $current_node ]] || ! [[ $current_major =~ ^[0-9]+$ && $current_minor =~ ^[0-9]+$ ]] ||
    ((current_major != required_major || current_minor < required_minor)); then
    if command -v mise >/dev/null 2>&1; then
      if mise_node_dir=$(mise where "node@${required_node}" 2>/dev/null) && [[ -d "$mise_node_dir/bin" ]]; then
        export PATH="$mise_node_dir/bin:$PATH"
      fi
    fi
  fi

  current_pnpm=$(pnpm --version 2>/dev/null || true)
  if [[ $current_pnpm != "$required_pnpm" ]] && command -v mise >/dev/null 2>&1; then
    if mise_pnpm_dir=$(mise where "pnpm@${required_pnpm}" 2>/dev/null) && [[ -d "$mise_pnpm_dir" ]]; then
      export PATH="$mise_pnpm_dir:$PATH"
    fi
  fi

  if ! command -v node >/dev/null 2>&1; then
    printf 'FAIL: node not found; install Node %s (see .node-version).\n' "$required_node" >&2
    return 2
  fi
  node -e '
    const req = process.argv[1].split(".").map(Number);
    const cur = process.versions.node.split(".").map(Number);
    if (cur[0] !== req[0] || cur[1] < req[1]) {
      console.error(`FAIL: require Node >=${req[0]}.${req[1]}.0 <${req[0] + 1}, found ${process.versions.node}`);
      process.exit(2);
    }
  ' "$required_node" || return 2

  if ! command -v pnpm >/dev/null 2>&1; then
    printf 'FAIL: pnpm not found; install pnpm@%s (see package.json).\n' "$required_pnpm" >&2
    return 2
  fi
  current_pnpm=$(pnpm --version 2>/dev/null || true)
  if [[ $current_pnpm != "$required_pnpm" ]]; then
    printf 'FAIL: require pnpm %s (see package.json), found %s.\n' "$required_pnpm" "${current_pnpm:-unavailable}" >&2
    return 2
  fi
}

verify_port_listeners() {
  local port=$1
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltnp "sport = :$port" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 || true
  else
    printf 'FAIL: neither ss nor lsof is available to inspect port %s.\n' "$port" >&2
    return 2
  fi
}

verify_assert_port_free() {
  local port=$1
  if [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
    printf 'FAIL: invalid port: %s\n' "$port" >&2
    return 2
  fi
  local listeners
  listeners=$(verify_port_listeners "$port") || return 2
  if [[ -n $listeners ]]; then
    printf 'FAIL: port %s is already owned; pick another port instead of driving an unknown owner.\n%s\n' "$port" "$listeners" >&2
    return 2
  fi
}
