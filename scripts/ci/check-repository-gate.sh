#!/usr/bin/env bash
set -euo pipefail

# Local merge-request repository gate. Any future CI adapter resolves its
# platform's target ref and calls this script, or make check-repository-gate.
#
# Inputs (environment):
#   BASE  target ref or diff base commit (required); the gate diffs from
#         merge-base(BASE, HEAD), so a branch tip works locally

if [[ -z "${BASE:-}" ]]; then
  echo "Usage: BASE=<target-ref> $0  (or: make check-repository-gate BASE=<target-ref>)" >&2
  exit 2
fi

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
head_sha="$(git rev-parse --verify "HEAD^{commit}")"
base_tip="$(git rev-parse --verify "${BASE}^{commit}")"
# A local target tip may have moved past the merge base.
base="$(git merge-base "$base_tip" "$head_sha")"
# The make targets below take no base; keep the caller's value out of them.
unset BASE

if ! git diff --quiet "$base" "$head_sha" -- 'apps/teamhub/migrations/*.sql'; then
  # Compare SQL with the current target tip, not just the old diff base:
  # long-lived branches can otherwise reuse a version added upstream.
  bash "$script_root/../../apps/teamhub/scripts/check-migration-history.sh" \
    "$base_tip" "$head_sha"
fi

# commitlint rejects an empty range, which a base equal to HEAD gives.
if [[ "$base" != "$head_sha" ]]; then
  pnpm exec commitlint --from "$base" --to "$head_sha" --verbose
fi

# Every variable runtime code reads is documented in .env.example or the inventory.
pnpm env:inventory:check

# Format, lint and check the English-only rule on the files this branch adds
# or changes. ESLint skips the prefixes in app-linted-paths.txt: CI selects
# the owning app's check whenever a path under a prefix changes, and that
# check lints the whole prefix with --max-warnings=0.
bash "$script_root/check-changed-files.sh" "$base" "$head_sha" \
  "$script_root/app-linted-paths.txt"

# Run the script test suite when the range is empty (push baseline or force
# push) or when check-plan selects check-scripts-fast for the changed files;
# any planning error fails closed and runs it.
run_scripts_fast=true
if [[ "$base" != "$head_sha" ]]; then
  if planned="$(git diff --name-only "$base" "$head_sha" | node "$script_root/../check-plan.mjs" --files-from - --format make 2>/dev/null)"; then
    if [[ " $planned " != *" check-scripts-fast "* ]]; then
      run_scripts_fast=false
    fi
  fi
fi

if [[ "$run_scripts_fast" == true ]]; then
  make check-scripts-fast check-docs
else
  make check-docs
fi
