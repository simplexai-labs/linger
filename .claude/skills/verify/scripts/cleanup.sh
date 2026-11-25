#!/usr/bin/env bash
# Tears down any processes, label-verified disposable Postgres Compose projects,
# or temporary homes started by one verification run, checks that its ports are
# free, and confirms the proof artifacts under <evidence-dir> survived intact.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=toolchain.sh
source "$script_dir/toolchain.sh"

usage() {
  cat <<'EOF'
Usage: .claude/skills/verify/scripts/cleanup.sh <evidence-dir>

Stops only PIDs, temporary homes, and label-verified teamhub-test-* Compose
resources recorded by the run in <evidence-dir> (under test-results/verify-linger/).
Never kills by process name and never deletes <evidence-dir>.
EOF
}

if (($# != 1)) || [[ "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit "$([[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && printf 0 || printf 2)"
fi

evidence_dir=$(cd "$1" 2>/dev/null && pwd || true)
if [[ -z $evidence_dir || ! -d $evidence_dir ]]; then
  printf 'FAIL: evidence directory does not exist: %s\n' "$1" >&2
  exit 2
fi
if [[ ! -f "$evidence_dir/source.txt" ]]; then
  printf 'FAIL: %s does not look like a verification evidence directory (missing source.txt).\n' "$evidence_dir" >&2
  exit 2
fi

failures=0

# 1. Stop any recorded PIDs from this run (never by process name).
if [[ -f "$evidence_dir/pids.txt" ]]; then
  while IFS= read -r pid; do
    [[ $pid =~ ^[0-9]+$ ]] || continue
    ((pid > 1 && pid != $$)) || continue
    if kill -0 "$pid" 2>/dev/null; then
      printf 'Stopping recorded PID %s...\n' "$pid"
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 25); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
      if kill -0 "$pid" 2>/dev/null; then
        printf 'FAIL: recorded PID %s is still alive\n' "$pid" >&2
        failures=$((failures + 1))
      fi
    fi
  done <"$evidence_dir/pids.txt"
fi

# 2. Remove any recorded temporary scratch homes strictly under temp dirs.
if [[ -f "$evidence_dir/temp-homes.txt" ]]; then
  while IFS= read -r home_dir; do
    [[ -n $home_dir ]] || continue
    if [[ -e "$home_dir" ]]; then
      case "$home_dir" in
        "${TMPDIR:-/tmp}"/linger-verify-* | /tmp/linger-verify-* | /private/tmp/linger-verify-*)
          printf 'Removing leftover scratch home %s...\n' "$home_dir"
          rm -rf -- "$home_dir"
          ;;
        *)
          printf 'FAIL: refusing to remove non-scratch path %s\n' "$home_dir" >&2
          failures=$((failures + 1))
          ;;
      esac
    fi
  done <"$evidence_dir/temp-homes.txt"
fi

# 3. Verify (and if stranded, label-check and remove) any teamhub-test-* Compose project logged by this run.
compose_file="$verify_repo_root/apps/teamhub/deployments/compose/docker-compose.test.yml"
if [[ -f "$evidence_dir/run.log" ]] && command -v docker >/dev/null 2>&1; then
  projects=$(grep -oE 'teamhub-test-[0-9]+-[0-9]+-[0-9]+' "$evidence_dir/run.log" | sort -u || true)
  if [[ -n $projects ]]; then
    while IFS= read -r project; do
      [[ -n $project ]] || continue
      container="${project}-postgres"
      network="${project}-network"

      if docker container inspect "$container" >/dev/null 2>&1 || docker network inspect "$network" >/dev/null 2>&1; then
        label_ok=1
        if docker container inspect "$container" >/dev/null 2>&1; then
          c_proj=$(docker container inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$container" 2>/dev/null || true)
          c_managed=$(docker container inspect --format '{{ index .Config.Labels "com.linger.teamhub.test-managed" }}' "$container" 2>/dev/null || true)
          c_token=$(docker container inspect --format '{{ index .Config.Labels "com.linger.teamhub.test-run-token" }}' "$container" 2>/dev/null || true)
          if [[ $c_proj != "$project" || $c_managed != "true" || $c_token != "$project" ]]; then
            printf 'FAIL: refusing to remove container %s with unexpected labels (%s/%s/%s)\n' "$container" "$c_proj" "$c_managed" "$c_token" >&2
            label_ok=0
            failures=$((failures + 1))
          fi
        fi
        if ((label_ok == 1)); then
          printf 'Removing stranded Compose project %s...\n' "$project"
          TEAMHUB_TEST_CONTAINER_NAME="$container" \
            TEAMHUB_TEST_NETWORK_NAME="$network" \
            TEAMHUB_TEST_RUN_TOKEN="$project" \
            TEAMHUB_TEST_POSTGRES_PORT=0 \
            docker compose --project-name "$project" --file "$compose_file" down --volumes || failures=$((failures + 1))
        fi
      fi

      if docker container inspect "$container" >/dev/null 2>&1; then
        printf 'FAIL: container %s still exists\n' "$container" >&2
        failures=$((failures + 1))
      fi
      if docker network inspect "$network" >/dev/null 2>&1; then
        printf 'FAIL: network %s still exists\n' "$network" >&2
        failures=$((failures + 1))
      fi
      volumes=$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project" 2>/dev/null || true)
      if [[ -n $volumes ]]; then
        printf 'FAIL: volumes remain for %s: %s\n' "$project" "$volumes" >&2
        failures=$((failures + 1))
      else
        printf 'Verified Compose project %s absent (container=0, network=0, volumes=0).\n' "$project"
      fi
    done <<<"$projects"
  fi
fi

# 4. Verify every port recorded for this run has no remaining listener.
recorded_ports=$(sed -nE 's/^(PLAYWRIGHT_ROOM_DOCUMENT_(WEB|TEAMHUB|CONTROL|RUNTIME)_PORT|VERIFY_COMPOSIO_PORT)=([0-9]+)$/\3/p' "$evidence_dir/source.txt" | sort -u || true)
if [[ -n $recorded_ports ]]; then
  while IFS= read -r port; do
    [[ -n $port && $port != "0" ]] || continue
    listeners=$(verify_port_listeners "$port")
    if [[ -n $listeners ]]; then
      printf 'FAIL: port %s still has a listener after teardown:\n%s\n' "$port" "$listeners" >&2
      failures=$((failures + 1))
    else
      printf 'Verified port %s free.\n' "$port"
    fi
  done <<<"$recorded_ports"
fi

# 5. Confirm proof artifacts survived cleanup intact.
for required in source.txt run.log exit-code.txt; do
  if [[ ! -f "$evidence_dir/$required" ]]; then
    printf 'FAIL: expected evidence artifact missing after cleanup: %s/%s\n' "$evidence_dir" "$required" >&2
    failures=$((failures + 1))
  fi
done
if [[ ! -f "$evidence_dir/proof.json" ]] && [[ -z $(find "$evidence_dir/browser" -maxdepth 3 -name 'proof.json' -o -name 'trace.zip' 2>/dev/null | head -n 1) ]]; then
  printf 'FAIL: no proof.json or trace.zip found under %s\n' "$evidence_dir" >&2
  failures=$((failures + 1))
fi

file_count=$(find "$evidence_dir" -type f | wc -l | tr -d '[:space:]')
printf 'Evidence preserved: %s (%s files)\n' "$evidence_dir" "$file_count"

if ((failures > 0)); then
  printf 'Cleanup completed with %d failure(s).\n' "$failures" >&2
  exit 1
fi
printf 'Cleanup verified clean (0 failures).\n'
