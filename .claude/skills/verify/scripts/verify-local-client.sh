#!/usr/bin/env bash
# Activates the pinned Node/pnpm toolchain and delegates Local Client
# (Desktop, Local Installer, Local Models, BYOK) verification to the canonical
# cross-platform runner in .agents/skills/verify-linger/scripts/verify-local-client.mjs.
# On Windows, invoke `node .agents/skills/verify-linger/scripts/verify-local-client.mjs` directly.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=toolchain.sh
source "$script_dir/toolchain.sh"
verify_activate_toolchain

exec node "$verify_repo_root/.agents/skills/verify-linger/scripts/verify-local-client.mjs" "$@"
