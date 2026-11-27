#!/usr/bin/env bash
set -euo pipefail

# Runs TLC against the DelegatedTaskApprovals TLA+ model using a pinned
# tla2tools.jar version (1.7.4 / TLC 2.19).
#
# By default, checks every INVARIANT declared in DelegatedTaskApprovals.cfg by
# peeling off any violated invariant and re-running the remaining ones until
# every passing invariant has been exhaustively checked across the full state
# space. Uses -workers 1 by default so counterexamples are deterministic
# shortest BFS traces.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL_DIR="$SKILL_DIR/model"
SPEC="$MODEL_DIR/DelegatedTaskApprovals.tla"
CFG="$MODEL_DIR/DelegatedTaskApprovals.cfg"

TLA2TOOLS_VERSION="1.7.4"
TLA2TOOLS_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
TLA2TOOLS_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA2TOOLS_VERSION}/tla2tools.jar"

usage() {
  cat <<'EOF'
Usage: check.sh [--invariant NAME] [--combined] [--workers N]

Options:
  --invariant NAME  Check only TypeOK and the named invariant (repeatable).
  --combined        Run TLC once on DelegatedTaskApprovals.cfg as written
                    (with deadlock checking; stops at the first violation).
  --workers N       TLC worker threads (default: 1 for shortest BFS traces).
  -h, --help        Show this help.
EOF
}

MODE="all"
WORKERS="1"
SELECTED_INVARIANTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --invariant)
      [[ $# -ge 2 ]] || { echo "error: --invariant requires a value" >&2; exit 2; }
      SELECTED_INVARIANTS+=("$2")
      shift 2
      ;;
    --combined)
      MODE="combined"
      shift
      ;;
    --workers)
      [[ $# -ge 2 ]] || { echo "error: --workers requires a value" >&2; exit 2; }
      WORKERS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "error: neither sha256sum nor shasum is installed" >&2
    exit 1
  fi
}

find_java() {
  if [[ -n "${JAVA_BIN:-}" ]]; then
    echo "$JAVA_BIN"
    return
  fi
  if command -v java >/dev/null 2>&1; then
    command -v java
    return
  fi
  echo "error: java not found on PATH (install Java 11+ or set JAVA_BIN)" >&2
  exit 1
}

ensure_tla2tools() {
  local jar="${TLA2TOOLS_JAR:-${XDG_CACHE_HOME:-$HOME/.cache}/tla2tools/${TLA2TOOLS_VERSION}/tla2tools.jar}"
  if [[ ! -f "$jar" ]]; then
    mkdir -p "$(dirname "$jar")"
    local tmp="${jar}.tmp.$$"
    echo "Downloading tla2tools.jar v${TLA2TOOLS_VERSION} to ${jar}..." >&2
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$TLA2TOOLS_URL" -o "$tmp"
    else
      echo "error: curl not found and ${jar} is missing" >&2
      exit 1
    fi
    mv "$tmp" "$jar"
  fi
  local actual
  actual="$(sha256_file "$jar")"
  if [[ "$actual" != "$TLA2TOOLS_SHA256" ]]; then
    echo "error: SHA-256 mismatch for ${jar}: got ${actual}, expected ${TLA2TOOLS_SHA256}" >&2
    exit 1
  fi
  echo "$jar"
}

JAVA="$(find_java)"
JAR="$(ensure_tla2tools)"
TMPDIR_RUN="$(mktemp -d "${TMPDIR:-/tmp}/delegated-task-approvals-tlc.XXXXXX")"
trap 'rm -rf "$TMPDIR_RUN"' EXIT

cp "$SPEC" "$TMPDIR_RUN/DelegatedTaskApprovals.tla"
SPEC_RUN="$TMPDIR_RUN/DelegatedTaskApprovals.tla"

run_tlc() {
  local cfg_name="$1"
  local meta_dir="$2"
  local out_file="$3"
  shift 3
  set +e
  (
    cd "$TMPDIR_RUN"
    "$JAVA" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
      -workers "$WORKERS" \
      -cleanup \
      -metadir "$meta_dir" \
      -config "$cfg_name" \
      "$@" \
      "$SPEC_RUN"
  ) >"$out_file" 2>&1
  local rc=$?
  set -e
  return "$rc"
}

if [[ "$MODE" == "combined" ]]; then
  cp "$CFG" "$TMPDIR_RUN/DelegatedTaskApprovals.cfg"
  OUT="$TMPDIR_RUN/combined.out"
  if run_tlc "DelegatedTaskApprovals.cfg" "$TMPDIR_RUN/meta-combined" "$OUT"; then
    cat "$OUT"
    exit 0
  else
    rc=$?
    cat "$OUT"
    exit "$rc"
  fi
fi

# Collect invariants from CFG (excluding TypeOK, which is always checked).
ALL_INVARIANTS=()
while IFS= read -r inv; do
  if [[ "$inv" != "TypeOK" ]]; then
    ALL_INVARIANTS+=("$inv")
  fi
done < <(awk '$1 == "INVARIANT" { print $2 }' "$CFG")

if [[ ${#SELECTED_INVARIANTS[@]} -gt 0 ]]; then
  REMAINING=("${SELECTED_INVARIANTS[@]}")
else
  REMAINING=("${ALL_INVARIANTS[@]}")
fi
TOTAL=${#REMAINING[@]}

BASE_CFG="$TMPDIR_RUN/base.cfg"
awk '$1 != "INVARIANT"' "$CFG" >"$BASE_CFG"

FAILURES=0
PASS=0
printf "Model: %s\nTool:  tla2tools.jar %s (workers=%s)\n\n" "$SPEC" "$TLA2TOOLS_VERSION" "$WORKERS"

ROUND=0
while [[ ${#REMAINING[@]} -gt 0 ]]; do
  ROUND=$((ROUND + 1))
  round_cfg_name="round-${ROUND}.cfg"
  round_cfg="$TMPDIR_RUN/${round_cfg_name}"
  round_out="$TMPDIR_RUN/round-${ROUND}.out"
  cp "$BASE_CFG" "$round_cfg"
  echo "INVARIANT TypeOK" >>"$round_cfg"
  for inv in "${REMAINING[@]}"; do
    echo "INVARIANT $inv" >>"$round_cfg"
  done

  if run_tlc "$round_cfg_name" "$TMPDIR_RUN/meta-${ROUND}" "$round_out" -deadlock; then
    stats="$(grep -E '^[0-9]+ states generated,' "$round_out" | tail -n 1 || true)"
    for inv in "${REMAINING[@]}"; do
      printf "PASS  %-44s %s\n" "$inv" "$stats"
      PASS=$((PASS + 1))
    done
    break
  fi

  violated="$(sed -n 's/^Error: Invariant \([^ ]*\) is violated\..*/\1/p' "$round_out" | head -n 1 || true)"
  if [[ -z "$violated" || "$violated" == "TypeOK" ]]; then
    echo "FAIL  model error or TypeOK violation:"
    cat "$round_out"
    exit 1
  fi

  FAILURES=$((FAILURES + 1))
  printf "FAIL  %-44s Error: Invariant %s is violated.\n" "$violated" "$violated"
  echo "----- counterexample ($violated) -----"
  awk '/^Error:/,/^Finished in /' "$round_out"
  echo "---------------------------------"

  NEXT_REMAINING=()
  for inv in "${REMAINING[@]}"; do
    if [[ "$inv" != "$violated" ]]; then
      NEXT_REMAINING+=("$inv")
    fi
  done
  REMAINING=("${NEXT_REMAINING[@]}")
done

echo ""
if [[ "$FAILURES" -gt 0 ]]; then
  echo "Result: ${PASS} passed, ${FAILURES} failed (of ${TOTAL} invariants)."
  exit 1
fi
echo "Result: all ${TOTAL} invariant(s) passed."
