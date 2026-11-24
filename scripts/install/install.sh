#!/usr/bin/env bash
set -Eeuo pipefail

# Guided interactive installer for Linger Docker Compose local models and
# Local Computer connection on macOS (Apple silicon) and Linux.

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
REPO_ROOT=""
SELF_CMD="./scripts/install/install.sh"
if [[ -n "$SCRIPT_PATH" && -e "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
  if [[ -f "$SCRIPT_DIR/../../docker-compose.yml" || -r "$SCRIPT_DIR/../installs/stack.sh" ]]; then
    REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
  else
    SELF_CMD="./$(basename -- "$SCRIPT_PATH")"
  fi
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/linger-install.XXXXXX")"
chmod 0700 "$WORK_DIR"
TEMP_KIT_DIR=""
cleanup() {
  rm -rf "$WORK_DIR"
  if [[ -n "$TEMP_KIT_DIR" ]]; then
    chmod -R u+w "$TEMP_KIT_DIR" 2>/dev/null || true
    rm -rf "$TEMP_KIT_DIR"
  fi
}
trap cleanup EXIT

MODE="guide"
EXPLICIT_WEB_URL=""
WEB_URL=""
CONNECT_LINGER=1
PURGE=0
YES=0

STACK_SCRIPT=""
KIT_PYTHON=""
PROMPT_VALUE=""

# >>> stack release pin
STACK_PIN_NPM_VERSION='0.1.0-dev.57'
STACK_PIN_SHA256='fcbfb72ff6495bbd638f0734b7d74f840d1442023379320f51344562bff60573'
# <<< stack release pin

usage() {
  cat <<EOF
Usage: $SELF_CMD [options]

Guided setup for Linger local models and connecting this computer to Linger.

Options:
  --web-url <origin>   Linger server URL (default: http://localhost:3000)
  --connect            Install and connect linger-computer only
  --up                 Start installed local models and refresh linger-computer
  --status             Show local model and linger-computer status
  --remove             Uninstall local model services (keeps downloaded files)
  --purge              With --remove, also delete downloaded weights and caches
  --yes                Confirm non-interactively for supported flags
  -h, --help           Show this help message
EOF
}

die() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

normalize_origin() {
  local raw
  raw="$(trim_whitespace "$1")"
  while [[ "$raw" == */ ]]; do
    raw="${raw%/}"
  done
  local origin_pattern='^https?://([a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\])(:[0-9]+)?$'
  if [[ ! "$raw" =~ $origin_pattern ]]; then
    return 1
  fi
  lowercase "$raw"
}

prompt_line() {
  local prompt_text="$1"
  local reply=""
  printf '%s' "$prompt_text"
  if [[ -n "$SCRIPT_PATH" ]]; then
    IFS= read -r reply || reply=""
  else
    IFS= read -r reply < /dev/tty || reply=""
  fi
  PROMPT_VALUE="$(trim_whitespace "$reply")"
}

prompt_secret() {
  local prompt_text="$1"
  local reply=""
  printf '%s' "$prompt_text"
  if [[ -n "$SCRIPT_PATH" ]]; then
    if [[ -t 0 ]]; then
      IFS= read -r -s reply || reply=""
      printf '\n'
    else
      IFS= read -r reply || reply=""
    fi
  elif [[ -r /dev/tty ]]; then
    IFS= read -r -s reply < /dev/tty || reply=""
    printf '\n' > /dev/tty 2>/dev/null || printf '\n'
  else
    IFS= read -r reply || reply=""
  fi
  PROMPT_VALUE="$reply"
}

read_env_value() {
  local env_file="$1"
  local key="$2"
  [[ -f "$env_file" ]] || return 1
  awk -v k="$key" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      line = $0
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      eq = index(line, "=")
      if (eq <= 0) next
      var = substr(line, 1, eq - 1)
      sub(/[[:space:]]+$/, "", var)
      if (var != k) next
      val = substr(line, eq + 1)
      sub(/^[[:space:]]+/, "", val)
      sub(/[[:space:]]+$/, "", val)
      if ((substr(val, 1, 1) == "\"" && substr(val, length(val), 1) == "\"") ||
          (substr(val, 1, 1) == "\x27" && substr(val, length(val), 1) == "\x27")) {
        val = substr(val, 2, length(val) - 2)
      }
      found = val
    }
    END {
      if (found != "") {
        print found
        exit 0
      }
      exit 1
    }
  ' "$env_file"
}

set_env_value() {
  local env_file="$1"
  local key="$2"
  local val="$3"
  local tmp_file="$WORK_DIR/env.tmp.$$"
  awk -v k="$key" -v v="$val" '
    BEGIN { replaced = 0 }
    {
      if ($0 ~ "^[[:space:]]*(#[[:space:]]*)?" k "=") {
        if (!replaced) {
          print k "=" v
          replaced = 1
        }
        next
      }
      print $0
    }
    END {
      if (!replaced) {
        print k "=" v
      }
    }
  ' "$env_file" > "$tmp_file"
  cat "$tmp_file" > "$env_file"
  rm -f "$tmp_file"
}

sanitize_engine_stream() {
  local escaped_self="${SELF_CMD//|/\\|}"
  sed -E \
    -e 's/^stack:/install.sh:/g' \
    -e 's/stack\.sh:/install.sh:/g' \
    -e 's/on Windows use stack\.ps1/on Windows use the Linger desktop app/g' \
    -e 's/stack\.ps1/the Linger desktop app/g' \
    -e "s/'stack service[^']*'/the existing local service/g" \
    -e "s/stack service [^;,.]*/the existing local service/g" \
    -e "s/ or plan another --llm-port//g" \
    -e "s|(python3 -m )?localmodels stack remove --purge|${escaped_self} --remove --purge|g" \
    -e "s|stack remove --purge|${escaped_self} --remove --purge|g" \
    -e "s|(python3 -m )?localmodels stack remove|${escaped_self} --remove|g" \
    -e "s|stack remove|${escaped_self} --remove|g" \
    -e "s|(python3 -m )?localmodels stack up|${escaped_self} --up|g" \
    -e "s|stack up|${escaped_self} --up|g" \
    -e "s|(python3 -m )?localmodels stack status|${escaped_self} --status|g" \
    -e "s|stack status|${escaped_self} --status|g" \
    -e "s|(python3 -m )?localmodels stack plan( --update)?|${escaped_self}|g" \
    -e "s|stack plan( --update)?|${escaped_self}|g" \
    -e "s|(python3 -m )?localmodels stack apply[^[:cntrl:]]*|${escaped_self}|g" \
    -e "s|stack apply[^[:cntrl:]]*|${escaped_self}|g" \
    -e "s|(python3 -m )?localmodels install|${escaped_self}|g" \
    -e 's/stack\.sh/install.sh/g'
}

run_sanitized_live() {
  local rc=0
  local line=""
  set +e
  "$@" 2>&1 | while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s\n' "$line" | sanitize_engine_stream
  done
  rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

computer_environment_name() {
  local rest="${1#*://}" host port name
  if [[ "$rest" == \[* ]]; then host="${rest%%]*}]"; else host="${rest%%:*}"; fi
  port="${rest#"$host"}"
  port="${port#:}"
  if [[ "$1" == http://* && "$port" == 80 ]] || [[ "$1" == https://* && "$port" == 443 ]]; then
    port=""
  fi
  case "$host" in
    localhost | *.localhost | 127.0.0.1 | '[::1]') name=local ;;
    \[*)
      name="${host#[}"
      name="ip-${name%]}"
      name="${name//[:.]/-}"
      ;;
    *)
      if [[ "$host" =~ ^[0-9.]+$ ]]; then
        name="ip-${host//./-}"
      else
        name="${host%%.*}"
        [[ "$name" == linger ]] || name="${name%-linger}"
      fi
      ;;
  esac
  [[ -z "$port" ]] || name="$name-$port"
  printf '%s\n' "$name"
}

check_supported_platform() {
  local sys arch
  sys="$(uname -s)"
  arch="$(uname -m)"
  case "$sys" in
    Linux) ;;
    Darwin)
      if [[ "$arch" != arm64 ]]; then
        die "macOS local models require Apple silicon (arm64); Intel Macs can use $SELF_CMD --connect against a remote server or another AI provider."
      fi
      ;;
    *)
      die "Unsupported operating system ($sys). On Windows, use the Linger desktop app or see docs/local-inference.md."
      ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is required."
}

canonical_existing_parent() {
  local target="$1"
  if [[ -d "$target" ]]; then
    (cd -- "$target" 2>/dev/null && pwd -P)
    return $?
  fi
  local parent base resolved_parent
  parent="$(dirname -- "$target")"
  base="$(basename -- "$target")"
  if [[ "$parent" == "$target" ]]; then
    printf '%s\n' "$target"
    return 0
  fi
  resolved_parent="$(canonical_existing_parent "$parent")" || return 1
  if [[ "$resolved_parent" == "/" ]]; then
    printf '/%s\n' "$base"
  else
    printf '%s/%s\n' "$resolved_parent" "$base"
  fi
}

ancestors_are_private() {
  local ancestor="$1"
  local owner bad_parent=""
  owner="$(id -u)"
  while :; do
    [[ ! -L "$ancestor" ]] || return 1
    if [[ -e "$ancestor" ]]; then
      bad_parent="$(find "$ancestor" -prune \( \( ! -user "$owner" ! -user 0 \) -o \( \( -perm -0020 -o -perm -0002 \) ! -perm -1000 \) \) -print 2>/dev/null || printf 'error')"
      [[ -z "$bad_parent" ]] || return 1
    fi
    [[ "$ancestor" != "/" ]] || break
    ancestor="$(dirname -- "$ancestor")"
  done
  return 0
}

ensure_private_subdir() {
  local dir="$1"
  local owner
  owner="$(id -u)"
  if [[ -L "$dir" ]]; then
    return 1
  fi
  if [[ -e "$dir" ]]; then
    [[ -d "$dir" ]] || return 1
    local owned
    owned="$(find "$dir" -prune -user "$owner" -print 2>/dev/null || true)"
    [[ -n "$owned" ]] || return 1
    chmod 0700 "$dir" 2>/dev/null || return 1
  else
    (umask 077 && mkdir -p "$dir") 2>/dev/null || return 1
  fi
  ancestors_are_private "$dir"
}

ensure_kit_home() {
  if [[ -n "${LOCALMODELS_KIT_HOME:-}" ]]; then
    export LOCALMODELS_KIT_HOME
    return 0
  fi

  local raw_cache="${XDG_CACHE_HOME:-$HOME/.cache}"
  local canon_cache=""
  canon_cache="$(canonical_existing_parent "$raw_cache" 2>/dev/null || true)"
  if [[ -n "$canon_cache" ]] && ancestors_are_private "$canon_cache"; then
    if ensure_private_subdir "$canon_cache/simplex-localmodels" &&
       ensure_private_subdir "$canon_cache/simplex-localmodels/kits"; then
      export LOCALMODELS_KIT_HOME="$canon_cache/simplex-localmodels/kits"
      return 0
    fi
  fi

  local real_home=""
  real_home="$(canonical_existing_parent "$HOME" 2>/dev/null || true)"
  if [[ -n "$real_home" ]] && ancestors_are_private "$real_home"; then
    if ensure_private_subdir "$real_home/.linger" &&
       ensure_private_subdir "$real_home/.linger/localmodels" &&
       ensure_private_subdir "$real_home/.linger/localmodels/kits"; then
      export LOCALMODELS_KIT_HOME="$real_home/.linger/localmodels/kits"
      return 0
    fi
  fi

  local real_tmp=""
  real_tmp="$(canonical_existing_parent "${TMPDIR:-/tmp}" 2>/dev/null || true)"
  if [[ -n "$real_tmp" ]] && ancestors_are_private "$real_tmp"; then
    TEMP_KIT_DIR="$(mktemp -d "$real_tmp/linger-kit.XXXXXX")"
    chmod 0700 "$TEMP_KIT_DIR"
    export LOCALMODELS_KIT_HOME="$TEMP_KIT_DIR"
    return 0
  fi
}

sha256_file() {
  local target="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk '{print $1}'
  else
    die "sha256sum or shasum is required."
  fi
}

download_pinned_stack_script() {
  local dest="$1"
  command -v tar >/dev/null 2>&1 || die "tar is required."
  [[ -n "$STACK_PIN_NPM_VERSION" && -n "$STACK_PIN_SHA256" ]] ||
    die "Local model runtime release pin is missing."

  local registries=()
  local override="${SIMPLEX_NPM_REGISTRY:-}"
  if [[ -n "$override" ]]; then
    override="${override%/}"
    case "$override" in
      https://?* | http://127.0.0.1 | http://127.0.0.1:* | http://127.0.0.1/* | http://localhost | http://localhost:* | http://localhost/*) ;;
      *) die "SIMPLEX_NPM_REGISTRY must use https or loopback http." ;;
    esac
    registries=("$override")
  else
    local region="${SIMPLEX_REGION:-auto}"
    case "$region" in
      auto | global) registries=("https://registry.npmjs.org" "https://registry.npmmirror.com") ;;
      cn) registries=("https://registry.npmmirror.com" "https://registry.npmjs.org") ;;
      *) die "SIMPLEX_REGION must be auto, global, or cn." ;;
    esac
  fi

  local tgz_file="$WORK_DIR/localmodels-launcher.tgz"
  local extracted="$WORK_DIR/stack.sh.download"
  local base="" proto="" tar_url="" pipe_rc="" extracted_bytes="" actual_sha=""
  for base in "${registries[@]}"; do
    case "$base" in
      https://*) proto='=https' ;;
      *) proto='=http,https' ;;
    esac
    tar_url="$base/@simplexai/localmodels/-/localmodels-${STACK_PIN_NPM_VERSION}.tgz"
    rm -f "$tgz_file" "$extracted"
    if ! curl -fsSL --proto "$proto" --proto-redir '=https' --max-redirs 5 --max-filesize 16777216 --retry 2 --connect-timeout 15 --max-time 60 -o "$tgz_file" "$tar_url" 2>/dev/null; then
      continue
    fi
    if (( $(wc -c < "$tgz_file" | tr -d ' ') > 16777216 )); then
      rm -f "$tgz_file"
      continue
    fi
    set +e
    tar -xzOf "$tgz_file" package/stack.sh 2>/dev/null | head -c 16777217 > "$extracted"
    pipe_rc="${PIPESTATUS[0]}:${PIPESTATUS[1]}"
    set -e
    extracted_bytes="$(wc -c < "$extracted" 2>/dev/null | tr -d ' ' || printf '0')"
    if (( extracted_bytes > 16777216 )); then
      rm -f "$extracted" "$tgz_file" "$dest"
      die "Local model runtime bootstrap exceeds maximum size."
    fi
    if [[ "$pipe_rc" != "0:0" ]]; then
      rm -f "$extracted"
      if ! tar -tzf "$tgz_file" >/dev/null 2>&1; then
        rm -f "$tgz_file"
        continue
      fi
      rm -f "$tgz_file"
      die "Downloaded runtime bootstrap archive is missing stack.sh."
    fi
    if [[ ! -s "$extracted" ]]; then
      rm -f "$extracted" "$tgz_file"
      die "Downloaded runtime bootstrap archive is missing stack.sh."
    fi
    actual_sha="$(sha256_file "$extracted")"
    if [[ "$actual_sha" != "$STACK_PIN_SHA256" ]]; then
      rm -f "$extracted" "$tgz_file" "$dest"
      die "Local model runtime bootstrap checksum mismatch."
    fi
    mv -f "$extracted" "$dest"
    chmod 0700 "$dest"
    rm -f "$tgz_file"
    return 0
  done

  rm -f "$tgz_file" "$extracted"
  die "Could not download the local model runtime bootstrap."
}

ensure_engine() {
  check_supported_platform
  ensure_kit_home
  if [[ -n "${LINGER_STACK_SCRIPT:-}" ]]; then
    [[ -r "$LINGER_STACK_SCRIPT" ]] || die "Configured engine helper is not readable: $LINGER_STACK_SCRIPT"
    STACK_SCRIPT="$LINGER_STACK_SCRIPT"
  elif [[ -n "$REPO_ROOT" && -r "$REPO_ROOT/scripts/installs/stack.sh" ]]; then
    STACK_SCRIPT="$REPO_ROOT/scripts/installs/stack.sh"
  elif [[ -n "${LINGER_STACK_URL:-}" ]]; then
    STACK_SCRIPT="$WORK_DIR/engine.sh"
    curl -fsSL "$LINGER_STACK_URL" -o "$STACK_SCRIPT" || die "Could not download the local model runtime bootstrap."
    chmod 0700 "$STACK_SCRIPT"
  else
    STACK_SCRIPT="$WORK_DIR/engine.sh"
    download_pinned_stack_script "$STACK_SCRIPT"
  fi

  local bootstrap_out=""
  local bootstrap_rc=0
  set +e
  bootstrap_out="$(sh "$STACK_SCRIPT" --bootstrap-json 2>"$WORK_DIR/bootstrap.err")"
  bootstrap_rc=$?
  set -e
  if (( bootstrap_rc != 0 )); then
    if [[ -s "$WORK_DIR/bootstrap.err" ]]; then
      sanitize_engine_stream < "$WORK_DIR/bootstrap.err" >&2
    fi
    die "Could not initialize the local model runtime."
  fi

  KIT_PYTHON="$(printf '%s' "$bootstrap_out" | sed -n 's/.*"python"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [[ -n "$KIT_PYTHON" && -x "$KIT_PYTHON" ]] || die "Runtime bootstrap did not return a valid Python executable."
}

default_web_url() {
  local candidate=""
  if [[ -n "$EXPLICIT_WEB_URL" ]]; then
    candidate="$EXPLICIT_WEB_URL"
  elif [[ -n "${LINGER_WEB_URL:-}" ]]; then
    candidate="$LINGER_WEB_URL"
  elif [[ -n "$REPO_ROOT" && -f "$REPO_ROOT/.env" ]]; then
    candidate="$(read_env_value "$REPO_ROOT/.env" "WEB_PUBLIC_ORIGIN" || true)"
  fi
  if [[ -z "$candidate" ]]; then
    candidate="http://localhost:3000"
  fi
  normalize_origin "$candidate" || die "Invalid Linger server URL: $candidate"
}

probe_linger_origin() {
  local origin="$1"
  local probe_file="$WORK_DIR/probe-linger.sh"
  if curl -fsS --max-time 5 "$origin/install/linger-computer.sh" -o "$probe_file" 2>/dev/null; then
    grep -Fq '# linger-computer-launcher-v2' "$probe_file"
    return $?
  fi
  return 1
}

compose_available() {
  [[ -n "$REPO_ROOT" && -f "$REPO_ROOT/docker-compose.yml" ]] &&
    command -v docker >/dev/null 2>&1 &&
    docker compose version >/dev/null 2>&1
}

collect_docker_host_ports() {
  tr ', ' '\n' | sed -nE 's/.*:([0-9]+)->[0-9]+\/(tcp|udp).*/\1\/\2/p' | sort -u
}

read_livekit_override_port() {
  local file="$1"
  local key="$2"
  local fallback="$3"
  local port=""
  if [[ -f "$file" ]]; then
    if [[ "$key" == "http" ]]; then
      port="$(sed -nE 's/.*:([0-9]+):7880"[[:space:]]*$/\1/p' "$file")"
    else
      port="$(sed -nE "s/.*--${key}[[:space:]]+([0-9]+).*/\1/p" "$file")"
    fi
  fi
  printf '%s\n' "${port:-$fallback}"
}

is_port_busy() {
  local port="$1"
  local proto="$2"
  local own_ports="$3"
  local docker_ports="$4"

  if [[ -n "$own_ports" ]] && printf '%s\n' "$own_ports" | grep -Fxq "$port/$proto"; then
    return 1
  fi

  if [[ -n "${LINGER_INSTALL_BUSY_PORTS+set}" ]]; then
    local spec=",${LINGER_INSTALL_BUSY_PORTS// /},"
    if [[ "$spec" == *",$port,"* || "$spec" == *",$port/$proto,"* ]]; then
      return 0
    fi
    return 1
  fi

  if [[ -n "$docker_ports" ]] && printf '%s\n' "$docker_ports" | grep -Fxq "$port/$proto"; then
    return 0
  fi

  if command -v ss >/dev/null 2>&1; then
    if [[ "$proto" == "udp" ]]; then
      ss -Huan "sport = :$port" 2>/dev/null | grep -q . && return 0
    else
      ss -Htan "sport = :$port" 2>/dev/null | grep -q . && return 0
    fi
    return 1
  fi

  if command -v lsof >/dev/null 2>&1; then
    if [[ "$proto" == "udp" ]]; then
      lsof -nP -iUDP:"$port" >/dev/null 2>&1 && return 0
    else
      lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    fi
  fi

  return 1
}

pick_free_port() {
  local candidate=$(( $1 + 1 ))
  local proto="$2"
  local own_ports="$3"
  local reserved="$4"
  local docker_ports="$5"
  local tries=0
  while (( tries < 200 )); do
    if [[ " $reserved " != *" $candidate "* ]] &&
       ! is_port_busy "$candidate" "$proto" "$own_ports" "$docker_ports"; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
    tries=$((tries + 1))
  done
  return 1
}

ensure_compose_ports() {
  local env_file="$REPO_ROOT/.env"
  local override_file="$REPO_ROOT/.local/compose.ports.yml"

  local own_raw=""
  own_raw="$(cd "$REPO_ROOT" && docker compose ps --format '{{.Ports}}' 2>/dev/null || true)"
  local own_ports=""
  if [[ -n "$own_raw" ]]; then
    own_ports="$(printf '%s\n' "$own_raw" | collect_docker_host_ports)"
  fi

  local docker_ports=""
  if [[ -z "${LINGER_INSTALL_BUSY_PORTS+set}" ]]; then
    local all_raw=""
    all_raw="$(docker ps --format '{{.Ports}}' 2>/dev/null || true)"
    if [[ -n "$all_raw" ]]; then
      docker_ports="$(printf '%s\n' "$all_raw" | collect_docker_host_ports)"
    fi
  fi

  local cur_pg cur_th cur_web cur_node cur_doc cur_lk_url cur_lk_http cur_lk_tcp cur_lk_udp
  cur_pg="$(read_env_value "$env_file" "POSTGRES_PORT" || printf '5432')"
  cur_th="$(read_env_value "$env_file" "TEAMHUB_HTTP_PORT" || printf '8080')"
  cur_web="$(read_env_value "$env_file" "WEB_HTTP_PORT" || printf '3000')"
  cur_node="$(read_env_value "$env_file" "NODE_SERVICES_HTTP_PORT" || printf '4319')"
  cur_doc="$(read_env_value "$env_file" "DOCUMENT_RUNTIME_HTTP_PORT" || printf '4321')"
  cur_lk_url="$(read_env_value "$env_file" "LIVEKIT_URL" || printf 'ws://127.0.0.1:17880')"
  cur_lk_http="$(read_livekit_override_port "$override_file" "http" "17880")"
  cur_lk_tcp="$(read_livekit_override_port "$override_file" "rtc[.]tcp_port" "7881")"
  cur_lk_udp="$(read_livekit_override_port "$override_file" "udp-port" "7882")"

  local reserved=" $cur_pg $cur_th $cur_web $cur_node $cur_doc $cur_lk_http $cur_lk_tcp $cur_lk_udp "
  local new_pg="$cur_pg"
  local new_th="$cur_th"
  local new_web="$cur_web"
  local new_node="$cur_node"
  local new_doc="$cur_doc"
  local new_lk_http="$cur_lk_http"
  local new_lk_tcp="$cur_lk_tcp"
  local new_lk_udp="$cur_lk_udp"

  local conflicts=()
  local changes=()

  if is_port_busy "$cur_pg" "tcp" "$own_ports" "$docker_ports"; then
    conflicts+=("$cur_pg")
    new_pg="$(pick_free_port "$cur_pg" "tcp" "$own_ports" "$reserved" "$docker_ports")" ||
      die "Could not find a free port for Postgres."
    reserved="$reserved$new_pg "
    changes+=("Postgres $cur_pg -> $new_pg")
  fi
  if is_port_busy "$cur_th" "tcp" "$own_ports" "$docker_ports"; then
    conflicts+=("$cur_th")
    new_th="$(pick_free_port "$cur_th" "tcp" "$own_ports" "$reserved" "$docker_ports")" ||
      die "Could not find a free port for TeamHub."
    reserved="$reserved$new_th "
    changes+=("TeamHub $cur_th -> $new_th")
  fi
  if is_port_busy "$cur_web" "tcp" "$own_ports" "$docker_ports"; then
    conflicts+=("$cur_web")
    new_web="$(pick_free_port "$cur_web" "tcp" "$own_ports" "$reserved" "$docker_ports")" ||
      die "Could not find a free port for Web."
    reserved="$reserved$new_web "
    changes+=("Web $cur_web -> $new_web")
  fi
  if is_port_busy "$cur_node" "tcp" "$own_ports" "$docker_ports"; then
    conflicts+=("$cur_node")
    new_node="$(pick_free_port "$cur_node" "tcp" "$own_ports" "$reserved" "$docker_ports")" ||
      die "Could not find a free port for Node Services."
    reserved="$reserved$new_node "
    changes+=("Node Services $cur_node -> $new_node")
  fi
  if is_port_busy "$cur_doc" "tcp" "$own_ports" "$docker_ports"; then
    conflicts+=("$cur_doc")
    new_doc="$(pick_free_port "$cur_doc" "tcp" "$own_ports" "$reserved" "$docker_ports")" ||
      die "Could not find a free port for Document Runtime."
    reserved="$reserved$new_doc "
    changes+=("Document Runtime $cur_doc -> $new_doc")
  fi
  if is_port_busy "$cur_lk_http" "tcp" "$own_ports" "$docker_ports"; then
    conflicts+=("$cur_lk_http")
    new_lk_http="$(pick_free_port "$cur_lk_http" "tcp" "$own_ports" "$reserved" "$docker_ports")" ||
      die "Could not find a free port for LiveKit HTTP."
    reserved="$reserved$new_lk_http "
    changes+=("LiveKit HTTP $cur_lk_http -> $new_lk_http")
  fi
  if is_port_busy "$cur_lk_tcp" "tcp" "$own_ports" "$docker_ports"; then
    conflicts+=("$cur_lk_tcp")
    new_lk_tcp="$(pick_free_port "$cur_lk_tcp" "tcp" "$own_ports" "$reserved" "$docker_ports")" ||
      die "Could not find a free port for LiveKit RTC TCP."
    reserved="$reserved$new_lk_tcp "
    changes+=("LiveKit RTC TCP $cur_lk_tcp -> $new_lk_tcp")
  fi
  if is_port_busy "$cur_lk_udp" "udp" "$own_ports" "$docker_ports"; then
    conflicts+=("$cur_lk_udp")
    new_lk_udp="$(pick_free_port "$cur_lk_udp" "udp" "$own_ports" "$reserved" "$docker_ports")" ||
      die "Could not find a free port for LiveKit RTC UDP."
    reserved="$reserved$new_lk_udp "
    changes+=("LiveKit RTC UDP $cur_lk_udp -> $new_lk_udp")
  fi

  if (( ${#conflicts[@]} == 0 )); then
    return 0
  fi

  local conflict_list=""
  local idx=0
  while (( idx < ${#conflicts[@]} )); do
    if (( idx > 0 )); then
      conflict_list="$conflict_list, "
    fi
    conflict_list="$conflict_list${conflicts[$idx]}"
    idx=$((idx + 1))
  done

  printf '  Port(s) already in use: %s\n' "$conflict_list"
  idx=0
  while (( idx < ${#changes[@]} )); do
    printf '    %s\n' "${changes[$idx]}"
    idx=$((idx + 1))
  done
  prompt_line "  Port(s) $conflict_list are already in use. Reassign to free local ports automatically (Web -> http://localhost:$new_web)? [Y/n]: "
  local port_ans=""
  port_ans="$(lowercase "$PROMPT_VALUE")"
  if [[ -n "$port_ans" && "$port_ans" != "y" && "$port_ans" != "yes" ]]; then
    die "Free those ports or update $env_file, then rerun $SELF_CMD."
  fi

  if [[ "$new_lk_http" != "$cur_lk_http" || "$new_lk_tcp" != "$cur_lk_tcp" || "$new_lk_udp" != "$cur_lk_udp" ]]; then
    local compose_version=""
    compose_version="$(docker compose version --short 2>/dev/null || true)"
    if [[ ! "$compose_version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]] ||
       ! (( BASH_REMATCH[1] > 2 ||
            (BASH_REMATCH[1] == 2 && (BASH_REMATCH[2] > 24 ||
             (BASH_REMATCH[2] == 24 && BASH_REMATCH[3] >= 4))) )); then
      die "Automatic LiveKit port reassignment requires Docker Compose 2.24.4 or later. Update Docker Compose and rerun $SELF_CMD."
    fi
  fi

  if [[ "$new_pg" != "$cur_pg" ]]; then
    set_env_value "$env_file" "POSTGRES_PORT" "$new_pg"
  fi
  if [[ "$new_th" != "$cur_th" ]]; then
    set_env_value "$env_file" "TEAMHUB_HTTP_PORT" "$new_th"
  fi
  if [[ "$new_web" != "$cur_web" ]]; then
    set_env_value "$env_file" "WEB_HTTP_PORT" "$new_web"
    local cur_origin=""
    cur_origin="$(read_env_value "$env_file" "WEB_PUBLIC_ORIGIN" || true)"
    if [[ -z "$EXPLICIT_WEB_URL" || "$EXPLICIT_WEB_URL" =~ ^http://(localhost|127\.0\.0\.1):${cur_web}$ ]] &&
       [[ -z "$cur_origin" || "$cur_origin" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]]; then
      set_env_value "$env_file" "WEB_PUBLIC_ORIGIN" "http://localhost:$new_web"
      EXPLICIT_WEB_URL=""
      WEB_URL="http://localhost:$new_web"
    fi
  fi
  if [[ "$new_node" != "$cur_node" ]]; then
    set_env_value "$env_file" "NODE_SERVICES_HTTP_PORT" "$new_node"
    local cur_gw=""
    cur_gw="$(read_env_value "$env_file" "AGENT_RUNNER_PUBLIC_GATEWAY_URL" || true)"
    if [[ -z "$cur_gw" || "$cur_gw" =~ ^ws://(127\.0\.0\.1|localhost): ]]; then
      set_env_value "$env_file" "AGENT_RUNNER_PUBLIC_GATEWAY_URL" "ws://127.0.0.1:$new_node/v1/runner-gateway"
    fi
  fi
  if [[ "$new_doc" != "$cur_doc" ]]; then
    set_env_value "$env_file" "DOCUMENT_RUNTIME_HTTP_PORT" "$new_doc"
  fi

  if [[ "$new_lk_http" != "$cur_lk_http" ]]; then
    if [[ -z "$cur_lk_url" || "$cur_lk_url" =~ ^ws://(127\.0\.0\.1|localhost): ]]; then
      set_env_value "$env_file" "LIVEKIT_URL" "ws://127.0.0.1:$new_lk_http"
    fi
  fi
  if [[ "$new_lk_http" != "$cur_lk_http" || "$new_lk_tcp" != "$cur_lk_tcp" || "$new_lk_udp" != "$cur_lk_udp" ]]; then
    mkdir -p "$(dirname "$override_file")"
    cat > "$override_file" <<EOF
services:
  livekit:
    entrypoint: /livekit-server --rtc.tcp_port $new_lk_tcp --udp-port $new_lk_udp
    ports: !override
      - "127.0.0.1:$new_lk_http:7880"
      - "\${LIVEKIT_RTC_BIND_ADDRESS:-127.0.0.1}:$new_lk_tcp:$new_lk_tcp"
      - "\${LIVEKIT_RTC_BIND_ADDRESS:-127.0.0.1}:$new_lk_udp:$new_lk_udp/udp"
EOF
    local compose_files=""
    compose_files="$(read_env_value "$env_file" "COMPOSE_FILE" || printf 'docker-compose.yml')"
    if [[ ":$compose_files:" != *":.local/compose.ports.yml:"* ]]; then
      set_env_value "$env_file" "COMPOSE_FILE" "$compose_files:.local/compose.ports.yml"
    fi
  fi
}

start_compose_server() {
  if [[ ! -f "$REPO_ROOT/.env" ]]; then
    [[ -f "$REPO_ROOT/.env.example" ]] || die "Missing $REPO_ROOT/.env.example."
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
    printf '  Created .env from .env.example.\n'
  fi

  mkdir -p "$REPO_ROOT/.linger-runtime/postgres-logs/stack" 2>/dev/null || true
  ensure_compose_ports

  printf '  Starting Linger with Docker Compose...\n'
  (cd "$REPO_ROOT" && docker compose up --build --detach --wait) || die "Docker Compose failed to start Linger."

  local env_origin=""
  env_origin="$(read_env_value "$REPO_ROOT/.env" "WEB_PUBLIC_ORIGIN" || true)"
  if [[ -z "$env_origin" ]]; then
    local env_web_port=""
    env_web_port="$(read_env_value "$REPO_ROOT/.env" "WEB_HTTP_PORT" || printf '3000')"
    env_origin="http://localhost:$env_web_port"
  fi
  WEB_URL="$(normalize_origin "$env_origin" || printf '%s' "$WEB_URL")"
  EXPLICIT_WEB_URL=""

  local waited=0
  while (( waited < 15 )); do
    if probe_linger_origin "$WEB_URL"; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if ! probe_linger_origin "$WEB_URL"; then
    die "Linger did not respond at $WEB_URL after Docker Compose started."
  fi
  printf '  Linger server is ready at %s\n' "$WEB_URL"

  prompt_line "  Create the initial owner account now? [Y/n]: "
  local create_owner=""
  create_owner="$(lowercase "$PROMPT_VALUE")"
  if [[ -z "$create_owner" || "$create_owner" == "y" || "$create_owner" == "yes" ]]; then
    local owner_email="owner@linger.local"
    prompt_line "  Owner email [owner@linger.local]: "
    if [[ -n "$PROMPT_VALUE" ]]; then
      owner_email="$PROMPT_VALUE"
    fi

    local owner_pw=""
    while :; do
      prompt_secret "  Owner password (min 8 chars, Enter for 'test1234'): "
      owner_pw="$PROMPT_VALUE"
      if [[ -z "$owner_pw" ]]; then
        owner_pw="test1234"
        printf '  Reminder: change the default password in Settings -> Security.\n'
        break
      fi
      if (( ${#owner_pw} >= 8 )); then
        break
      fi
      printf '  Password must be at least 8 characters.\n'
    done

    local owner_rc=0
    set +e
    printf '%s\n' "$owner_pw" | (
      cd "$REPO_ROOT" &&
      docker compose exec -T teamhub teamhub-account create-owner --email "$owner_email" --password-stdin
    )
    owner_rc=$?
    set -e
    unset owner_pw
    if (( owner_rc != 0 )); then
      printf '  Could not create owner account (an owner may already exist). You can sign in in your browser.\n'
    fi
  fi
}

prompt_custom_url() {
  while :; do
    prompt_line "  Enter Linger server URL (or 'skip' to install local models only): "
    local raw="$PROMPT_VALUE"
    if [[ "$(lowercase "$raw")" == "skip" || -z "$raw" ]]; then
      CONNECT_LINGER=0
      printf '  Continuing with local models only.\n'
      return 0
    fi
    local normalized=""
    if ! normalized="$(normalize_origin "$raw")"; then
      printf '  Invalid URL. Use an origin like http://localhost:3000 or https://linger.example.com.\n'
      continue
    fi
    if probe_linger_origin "$normalized"; then
      WEB_URL="$normalized"
      CONNECT_LINGER=1
      printf '  Found Linger server at %s\n' "$WEB_URL"
      return 0
    fi
    printf '  Could not reach a Linger server at %s.\n' "$normalized"
    prompt_line "  Use this URL anyway? [y/N]: "
    local force=""
    force="$(lowercase "$PROMPT_VALUE")"
    if [[ "$force" == "y" || "$force" == "yes" ]]; then
      WEB_URL="$normalized"
      CONNECT_LINGER=1
      return 0
    fi
  done
}

resolve_computer_env() {
  local bin_dir="${LINGER_COMPUTER_BIN_DIR:-$HOME/.local/bin}"
  local gateway_pi_dir="${LINGER_PI_AGENT_DIR:-$HOME/.local/share/localmodels/tools/gateway-home/.pi/agent}"
  local runtime_path="$bin_dir:$HOME/.local/bin:$PATH"
  COMPUTER_ENV=("PATH=$runtime_path")
  if [[ -f "$gateway_pi_dir/models.json" ]]; then
    COMPUTER_ENV+=("PI_CODING_AGENT_DIR=$gateway_pi_dir")
  fi
  RESOLVED_PI_BIN=""
  if [[ -x "$HOME/.local/bin/pi" ]]; then
    RESOLVED_PI_BIN="$HOME/.local/bin/pi"
  else
    RESOLVED_PI_BIN="$(PATH="$runtime_path" command -v pi 2>/dev/null || true)"
  fi
  RESOLVED_GATEWAY_PI_DIR="$gateway_pi_dir"
}

run_connect_step() {
  local downloader_file="$WORK_DIR/install-linger-computer.sh"
  printf '  Downloading Linger Computer installer from %s...\n' "$WEB_URL"
  curl -fsSL "$WEB_URL/install/linger-computer.sh" -o "$downloader_file" ||
    die "Failed to download the Linger Computer installer from $WEB_URL."
  grep -Fq '# linger-computer-launcher-v2' "$downloader_file" ||
    die "$WEB_URL did not return a valid Linger Computer installer."

  LINGER_WEB_URL="$WEB_URL" bash "$downloader_file" ||
    die "Linger Computer installation failed."

  local env_name
  env_name="$(computer_environment_name "$WEB_URL")"
  local bin_dir="${LINGER_COMPUTER_BIN_DIR:-$HOME/.local/bin}"
  local computer_cli="$bin_dir/linger-computer-$env_name"
  [[ -x "$computer_cli" ]] || die "Expected command was not installed: $computer_cli"

  resolve_computer_env

  local auth_json=""
  auth_json="$("$computer_cli" auth status --json 2>/dev/null || true)"
  if printf '%s' "$auth_json" | grep -Eq '"authorized"[[:space:]]*:[[:space:]]*true'; then
    printf '  This computer is already linked to %s; restarting background daemon...\n' "$WEB_URL"
    env "${COMPUTER_ENV[@]+"${COMPUTER_ENV[@]}"}" "$computer_cli" daemon restart ||
      die "Failed to restart linger-computer-$env_name."
  else
    printf '  Sign in to link this computer to Linger (%s)...\n' "$WEB_URL"
    if [[ -n "$RESOLVED_PI_BIN" ]]; then
      env "${COMPUTER_ENV[@]+"${COMPUTER_ENV[@]}"}" "$computer_cli" login --web-url "$WEB_URL" --pi-path "$RESOLVED_PI_BIN" ||
        die "Could not sign in linger-computer-$env_name."
    else
      env "${COMPUTER_ENV[@]+"${COMPUTER_ENV[@]}"}" "$computer_cli" login --web-url "$WEB_URL" ||
        die "Could not sign in linger-computer-$env_name."
    fi
  fi

  if [[ -f "$RESOLVED_GATEWAY_PI_DIR/models.json" ]]; then
    printf '  Verifying Pi local model connection...\n'
    if [[ -n "$RESOLVED_PI_BIN" ]]; then
      env "${COMPUTER_ENV[@]+"${COMPUTER_ENV[@]}"}" "$computer_cli" runtime check pi --live --pi-path "$RESOLVED_PI_BIN" ||
        die "Pi local model verification failed."
    else
      env "${COMPUTER_ENV[@]+"${COMPUTER_ENV[@]}"}" "$computer_cli" runtime check pi --live ||
        die "Pi local model verification failed."
    fi
  fi

  printf '\nDone.\n'
  printf '  Linger server: %s\n' "$WEB_URL"
  printf '  Computer CLI:  linger-computer-%s\n' "$env_name"
  if [[ ":${PATH}:" != *":${bin_dir}:"* ]]; then
    printf '  Note: add %s to PATH if you want to invoke linger-computer-%s directly.\n' "$bin_dir" "$env_name"
  fi
  printf '  Day-2 commands: %s --status | %s --up | %s --remove\n' "$SELF_CMD" "$SELF_CMD" "$SELF_CMD"
}

step_check_server() {
  printf '\n[1/4] Checking Linger server\n'
  WEB_URL="$(default_web_url)"
  if probe_linger_origin "$WEB_URL"; then
    CONNECT_LINGER=1
    printf '  Found Linger server at %s\n' "$WEB_URL"
    return 0
  fi

  printf '  Could not reach a Linger server at %s.\n' "$WEB_URL"
  if compose_available; then
    printf '  Choose how to proceed:\n'
    printf '    1) Start Linger on this computer with Docker Compose (recommended)\n'
    printf '    2) Enter the URL of an existing Linger server\n'
    printf '    3) Install local models only (connect to Linger later)\n'
    prompt_line "  Choice [1-3] (default: 1): "
    case "${PROMPT_VALUE:-1}" in
      1)
        start_compose_server
        CONNECT_LINGER=1
        ;;
      2)
        prompt_custom_url
        ;;
      3)
        CONNECT_LINGER=0
        printf '  Continuing with local models only.\n'
        ;;
      *)
        die "Invalid choice: $PROMPT_VALUE"
        ;;
    esac
  else
    printf '  Choose how to proceed:\n'
    printf '    1) Enter the URL of an existing Linger server\n'
    printf '    2) Install local models only (connect to Linger later)\n'
    prompt_line "  Choice [1-2] (default: 1): "
    case "${PROMPT_VALUE:-1}" in
      1)
        prompt_custom_url
        ;;
      2)
        CONNECT_LINGER=0
        printf '  Continuing with local models only.\n'
        ;;
      *)
        die "Invalid choice: $PROMPT_VALUE"
        ;;
    esac
  fi
}

step_check_hardware_and_options() {
  printf '\n[2/4] Checking hardware and model options\n'
  printf '  Preparing local model installer...\n'
  ensure_engine

  MODEL_ACTION="plan"
  HAS_ACCEPTED_STACK=0
  SHARED_GPU_APPROVED=0
  PLAN_ARGS=()

  set +e
  sh "$STACK_SCRIPT" status --json > "$WORK_DIR/status.json" 2>"$WORK_DIR/status.err"
  local status_rc=$?
  set -e

  if (( status_rc == 0 )) && [[ -s "$WORK_DIR/status.json" ]]; then
    local existing_info=""
    existing_info="$("$KIT_PYTHON" -I -B -c '
import json, sys
try:
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(0)
last_run = doc.get("last_run")
if isinstance(last_run, dict) and last_run.get("ok") is True:
    deps = doc.get("deployments") or []
    names = ", ".join(str(d.get("name", "")) for d in deps if isinstance(d, dict) and d.get("name")) or "local model stack"
    print(names)
' "$WORK_DIR/status.json" 2>/dev/null || true)"
    if [[ -n "$existing_info" ]]; then
      printf '  An installed local model stack is already present (%s).\n' "$existing_info"
      printf '    1) Use existing local model setup and ensure it is running (recommended)\n'
      printf '    2) Plan and install an updated model configuration\n'
      prompt_line "  Choice [1-2] (default: 1): "
      case "${PROMPT_VALUE:-1}" in
        1)
          MODEL_ACTION="reuse"
          return 0
          ;;
        2)
          MODEL_ACTION="plan"
          HAS_ACCEPTED_STACK=1
          ;;
        *)
          die "Invalid choice: $PROMPT_VALUE"
          ;;
      esac
    fi
  fi

  set +e
  sh "$STACK_SCRIPT" hardware --json > "$WORK_DIR/hardware.json" 2>"$WORK_DIR/hardware.err"
  local hw_rc=$?
  set -e
  if (( hw_rc != 0 )); then
    if [[ -s "$WORK_DIR/hardware.err" ]]; then
      sanitize_engine_stream < "$WORK_DIR/hardware.err" >&2
    fi
    die "Hardware inspection failed."
  fi

  "$KIT_PYTHON" -I -B -c '
import json, sys

doc = json.load(open(sys.argv[1], encoding="utf-8"))
picks_out = sys.argv[2]

def gib(b):
    if b is None:
        return "unknown"
    return f"{int(b) / (1024 ** 3):.1f} GiB"

system = doc.get("system") or "unknown"
arch = doc.get("arch") or ""
ram_avail = gib(doc.get("ram_available_bytes"))
ram_total = gib(doc.get("ram_total_bytes"))
disk_free = gib(doc.get("disk_free_bytes"))
print(f"  Host: {system} ({arch}) · RAM: {ram_avail} free / {ram_total} total · Disk: {disk_free} free")

cards = doc.get("cards") or []
if cards:
    for c in cards:
        held = c.get("held_by") or []
        state = "processes running" if (held or not c.get("auto")) else "available"
        idx = c.get("index", 0)
        cname = c.get("name") or "GPU"
        cfree = gib(c.get("free_bytes"))
        ctot = gib(c.get("total_bytes"))
        print(f"  GPU {idx}: {cname} ({cfree} free / {ctot} total, {state})")
else:
    print("  GPU: none detected")

problem = doc.get("planning_problem")
if problem:
    print(f"  Note: {problem}")

with open(picks_out, "w", encoding="utf-8") as fh:
    for p in doc.get("picks") or []:
        tok_s = float(p.get("decode_tok_s") or 0)
        card = p.get("card")
        fields = [
            str(p.get("role") or ""),
            str(p.get("id") or ""),
            str(p.get("quant") or ""),
            str(p.get("quality") or 0),
            f"{tok_s:.0f}",
            "measured" if p.get("decode_basis") == "measured-decode" else "estimated",
            str(card if card is not None else 0),
            "1" if p.get("shared") else "0",
        ]
        fh.write("\t".join(fields) + "\n")
' "$WORK_DIR/hardware.json" "$WORK_DIR/picks.tsv"

  local pick_roles=()
  local pick_ids=()
  local pick_quants=()
  local pick_scores=()
  local pick_speeds=()
  local pick_bases=()
  local pick_cards=()
  local pick_shared=()
  while IFS=$'\t' read -r p_role p_id p_quant p_score p_speed p_basis p_card p_shared; do
    [[ -n "$p_id" ]] || continue
    pick_roles+=("$p_role")
    pick_ids+=("$p_id")
    pick_quants+=("$p_quant")
    pick_scores+=("$p_score")
    pick_speeds+=("$p_speed")
    pick_bases+=("$p_basis")
    pick_cards+=("$p_card")
    pick_shared+=("$p_shared")
  done < "$WORK_DIR/picks.tsv"

  local count="${#pick_ids[@]}"
  if (( count == 0 )); then
    die "No supported local model fits the currently available memory and disk."
  fi

  local chosen_idx=0
  if (( count >= 2 )); then
    printf '\n  Available model options:\n'
    local i=0
    while (( i < count )); do
      local label_role="${pick_roles[$i]}"
      if [[ "$label_role" == "smartest" ]]; then
        label_role="Smartest (recommended)"
      elif [[ "$label_role" == "fastest" ]]; then
        label_role="Fastest"
      fi
      printf '    %d) %s (%s) — %s, score %s, %s tok/s (%s)\n' \
        "$((i + 1))" "${pick_ids[$i]}" "${pick_quants[$i]}" "$label_role" \
        "${pick_scores[$i]}" "${pick_speeds[$i]}" "${pick_bases[$i]}"
      i=$((i + 1))
    done
    prompt_line "  Choose a model [1-$count] (default: 1): "
    local sel="${PROMPT_VALUE:-1}"
    if [[ ! "$sel" =~ ^[0-9]+$ ]] || (( sel < 1 || sel > count )); then
      die "Invalid choice: $sel"
    fi
    chosen_idx=$((sel - 1))
  else
    printf '  Recommended model: %s (%s) — score %s, %s tok/s (%s)\n' \
      "${pick_ids[0]}" "${pick_quants[0]}" "${pick_scores[0]}" "${pick_speeds[0]}" "${pick_bases[0]}"
  fi

  local selected_role="${pick_roles[$chosen_idx]}"
  local selected_card="${pick_cards[$chosen_idx]}"
  local selected_shared="${pick_shared[$chosen_idx]}"
  if [[ -n "$selected_role" && "$selected_role" != "smartest" ]]; then
    PLAN_ARGS+=("--prefer" "$selected_role")
  fi

  if [[ "$selected_shared" == "1" ]]; then
    prompt_line "  GPU $selected_card already has running processes. Share GPU $selected_card? [Y/n]: "
    local share_ans=""
    share_ans="$(lowercase "$PROMPT_VALUE")"
    if [[ -n "$share_ans" && "$share_ans" != "y" && "$share_ans" != "yes" ]]; then
      printf '  Installation cancelled.\n'
      exit 0
    fi
    SHARED_GPU_APPROVED=1
    PLAN_ARGS+=("--gpu" "$selected_card" "--share-gpu")

    local gpu_mem_cap=""
    while :; do
      prompt_line "  Optional GPU memory limit for model sizing (e.g. 24G, Enter for auto): "
      gpu_mem_cap="$PROMPT_VALUE"
      if [[ -z "$gpu_mem_cap" ]]; then
        break
      fi
      if [[ "$gpu_mem_cap" =~ ^[0-9]+([.][0-9]+)?[KkMmGgTt]?$ ]]; then
        PLAN_ARGS+=("--gpu-memory" "$gpu_mem_cap")
        break
      fi
      printf '  Please enter a size like 24G or 16384M, or press Enter for automatic sizing.\n'
    done
  fi

  prompt_line "  Also install optional routing, embedding, and reranker helper models? [y/N]: "
  local helpers_ans=""
  helpers_ans="$(lowercase "$PROMPT_VALUE")"
  if [[ "$helpers_ans" == "y" || "$helpers_ans" == "yes" ]]; then
    PLAN_ARGS+=("--decision" "auto" "--aux" "embedding,reranker")
  fi

  if (( HAS_ACCEPTED_STACK == 1 )); then
    PLAN_ARGS+=("--update")
  fi
}

step_install_and_verify_model() {
  printf '\n[3/4] Installing and verifying the local model\n'
  if [[ "$MODEL_ACTION" == "reuse" ]]; then
    printf '  Starting existing local model services...\n'
    local up_rc=0
    if run_sanitized_live sh "$STACK_SCRIPT" up; then
      return 0
    else
      up_rc=$?
    fi
    prompt_line "  Retry starting while sharing GPU with other running processes? [Y/n]: "
    local retry_ans=""
    retry_ans="$(lowercase "$PROMPT_VALUE")"
    if [[ -z "$retry_ans" || "$retry_ans" == "y" || "$retry_ans" == "yes" ]]; then
      run_sanitized_live sh "$STACK_SCRIPT" up --share-gpu || die "Could not start the installed local model stack."
      return 0
    fi
    exit "$up_rc"
  fi

  printf '  Preparing installation plan...\n'
  set +e
  sh "$STACK_SCRIPT" plan "${PLAN_ARGS[@]+"${PLAN_ARGS[@]}"}" --out "$WORK_DIR/plan.json" --json > /dev/null 2>"$WORK_DIR/plan.err"
  local plan_rc=$?
  set -e
  if (( plan_rc != 0 )); then
    if [[ -s "$WORK_DIR/plan.err" ]]; then
      sanitize_engine_stream < "$WORK_DIR/plan.err" >&2
    fi
    die "Could not create a local model installation plan."
  fi

  "$KIT_PYTHON" -I -B -c '
import json, sys

plan = json.load(open(sys.argv[1], encoding="utf-8"))
meta_out = sys.argv[2]
shared_gpu_approved = len(sys.argv) > 3 and sys.argv[3] == "1"

def gib(b):
    if b is None:
        return "0.0 GiB"
    return f"{int(b) / (1024 ** 3):.1f} GiB"

llm = plan.get("llm") or {}
model = llm.get("model") or {}
placement = llm.get("placement") or {}
launch = llm.get("launch") or {}
window = int(launch.get("window") or 0)
win_label = f"{window // 1024}K" if window >= 1024 else str(window)
mname = model.get("display_name") or model.get("id") or "unknown"
mquant = model.get("quant") or ""
plabel = placement.get("label") or ""

print("\n  Plan summary:")
print(f"    Model:     {mname} ({mquant}), {plabel}, context {win_label}")

helpers = []
dec = plan.get("decision")
if isinstance(dec, dict):
    dm = dec.get("model") or {}
    dname = dm.get("display_name") or dm.get("id") or "auto"
    helpers.append(f"routing ({dname})")
for part in plan.get("aux") or []:
    if isinstance(part, dict):
        contract = (part.get("endpoint") or {}).get("contract") or part.get("name") or "helper"
        pm = part.get("model") or {}
        pname = pm.get("display_name") or pm.get("id") or ""
        helpers.append(f"{contract} ({pname})")
if helpers:
    print("    Helpers:   " + ", ".join(helpers))

budget = plan.get("budget") or {}
dl_s = gib(budget.get("download_bytes"))
disk_s = gib(budget.get("disk_needed_bytes"))
ram_need = gib(budget.get("ram_needed_bytes"))
ram_avail = gib(budget.get("ram_available_bytes"))
print(f"    Resources: download {dl_s}, disk {disk_s}, RAM {ram_need} / {ram_avail} available")

preflight = plan.get("preflight") or {}
findings = preflight.get("findings") or []
for item in findings:
    if not isinstance(item, dict):
        continue
    level = item.get("level")
    check_id = item.get("check") or ""
    detail = item.get("detail") or ""
    fix = item.get("fix") or ""
    if level == "fail":
        print(f"    Check failed: {detail}")
        if fix:
            print(f"      Fix: {fix}")
    elif level == "warn":
        if check_id == "preflight.gpu" and shared_gpu_approved:
            continue
        if check_id == "preflight.running":
            print(f"    Note:      {detail} (kept untouched on separate ports)")
            continue
        print(f"    Note:      {detail}")
        if fix:
            print(f"      Hint: {fix}")

counts = preflight.get("counts") or {}
fail_count = int(counts.get("fail") or 0)
plan_id = plan.get("plan_id") or ""
with open(meta_out, "w", encoding="utf-8") as fh:
    fh.write(f"{plan_id}\t{fail_count}\n")
' "$WORK_DIR/plan.json" "$WORK_DIR/plan_meta.tsv" "$SHARED_GPU_APPROVED" | sanitize_engine_stream

  local plan_id=""
  local fail_count="0"
  IFS=$'\t' read -r plan_id fail_count < "$WORK_DIR/plan_meta.tsv"
  [[ -n "$plan_id" ]] || die "Generated plan did not include a plan identifier."
  if (( fail_count > 0 )); then
    die "Preflight checks failed; fix the issues above and rerun $SELF_CMD."
  fi

  prompt_line "  Approve download and installation? [y/N]: "
  local approve=""
  approve="$(lowercase "$PROMPT_VALUE")"
  if [[ "$approve" != "y" && "$approve" != "yes" ]]; then
    printf '  Installation cancelled. Nothing was downloaded or changed.\n'
    exit 0
  fi

  if run_sanitized_live sh "$STACK_SCRIPT" apply "$WORK_DIR/plan.json" --approve "$plan_id"; then
    :
  else
    die "Local model installation did not finish; fix the issue above and rerun $SELF_CMD."
  fi
}

step_connect_linger() {
  printf '\n[4/4] Connecting this computer to Linger\n'
  if (( CONNECT_LINGER == 0 )); then
    printf '  Local model is ready. When your Linger server is running, connect with:\n'
    printf '    %s --connect --web-url http://localhost:3000\n' "$SELF_CMD"
    return 0
  fi
  run_connect_step
}

run_connect_mode() {
  check_supported_platform
  WEB_URL="$(default_web_url)"
  if ! probe_linger_origin "$WEB_URL"; then
    printf 'Could not reach a Linger server at %s.\n' "$WEB_URL"
    prompt_custom_url
    if (( CONNECT_LINGER == 0 )); then
      return 0
    fi
  fi
  run_connect_step
}

run_up_mode() {
  ensure_engine
  local up_rc=0
  if run_sanitized_live sh "$STACK_SCRIPT" up; then
    :
  else
    up_rc=$?
    exit "$up_rc"
  fi

  local candidate_url=""
  candidate_url="$(default_web_url)"
  local env_name
  env_name="$(computer_environment_name "$candidate_url")"
  local bin_dir="${LINGER_COMPUTER_BIN_DIR:-$HOME/.local/bin}"
  local computer_cli="$bin_dir/linger-computer-$env_name"
  if [[ -x "$computer_cli" ]]; then
    local auth_json=""
    auth_json="$("$computer_cli" auth status --json 2>/dev/null || true)"
    if printf '%s' "$auth_json" | grep -Eq '"authorized"[[:space:]]*:[[:space:]]*true'; then
      resolve_computer_env
      env "${COMPUTER_ENV[@]+"${COMPUTER_ENV[@]}"}" "$computer_cli" daemon restart ||
        die "Failed to restart linger-computer-$env_name."
    fi
  fi
}

run_status_mode() {
  ensure_engine
  local status_out=""
  local status_rc=0
  set +e
  status_out="$(sh "$STACK_SCRIPT" status 2>&1)"
  status_rc=$?
  set -e
  if [[ -n "$status_out" ]]; then
    printf '%s\n' "$status_out" | sanitize_engine_stream
  fi

  local candidate_url=""
  candidate_url="$(default_web_url)"
  local env_name
  env_name="$(computer_environment_name "$candidate_url")"
  local bin_dir="${LINGER_COMPUTER_BIN_DIR:-$HOME/.local/bin}"
  local computer_cli="$bin_dir/linger-computer-$env_name"
  if [[ -x "$computer_cli" ]]; then
    printf '\nComputer (%s):\n' "linger-computer-$env_name"
    "$computer_cli" daemon status || true
  fi
  exit "$status_rc"
}

run_remove_mode() {
  ensure_engine
  local remove_out=""
  local remove_rc=0
  if (( PURGE == 1 && YES == 0 )); then
    set +e
    remove_out="$(sh "$STACK_SCRIPT" remove --purge --dry-run 2>&1)"
    remove_rc=$?
    set -e
    if [[ -n "$remove_out" ]]; then
      printf '%s\n' "$remove_out" | sanitize_engine_stream
    fi
    if (( remove_rc != 0 )); then
      exit "$remove_rc"
    fi
    prompt_line "Delete all downloaded model files and archives listed above? [y/N]: "
    local confirm_purge=""
    confirm_purge="$(lowercase "$PROMPT_VALUE")"
    if [[ "$confirm_purge" != "y" && "$confirm_purge" != "yes" ]]; then
      printf 'Nothing deleted.\n'
      return 0
    fi
    set +e
    remove_out="$(sh "$STACK_SCRIPT" remove --purge --yes 2>&1)"
    remove_rc=$?
    set -e
  elif (( PURGE == 1 )); then
    set +e
    remove_out="$(sh "$STACK_SCRIPT" remove --purge --yes 2>&1)"
    remove_rc=$?
    set -e
  else
    set +e
    remove_out="$(sh "$STACK_SCRIPT" remove 2>&1)"
    remove_rc=$?
    set -e
  fi

  if [[ -n "$remove_out" ]]; then
    printf '%s\n' "$remove_out" | sanitize_engine_stream
  fi
  exit "$remove_rc"
}

set_mode() {
  local requested="$1"
  if [[ "$MODE" != "guide" && "$MODE" != "$requested" ]]; then
    die "Options --$MODE and --$requested cannot be combined."
  fi
  MODE="$requested"
}

while (( $# > 0 )); do
  case "$1" in
    --web-url)
      (( $# >= 2 )) || die "--web-url requires an origin URL."
      EXPLICIT_WEB_URL="$2"
      shift 2
      ;;
    --web-url=*)
      EXPLICIT_WEB_URL="${1#--web-url=}"
      shift
      ;;
    --connect)
      set_mode "connect"
      shift
      ;;
    --up)
      set_mode "up"
      shift
      ;;
    --status)
      set_mode "status"
      shift
      ;;
    --remove)
      set_mode "remove"
      shift
      ;;
    --purge)
      PURGE=1
      shift
      ;;
    --yes)
      YES=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1 (run $SELF_CMD --help for usage)."
      ;;
  esac
done

case "$MODE" in
  connect) run_connect_mode ;;
  up) run_up_mode ;;
  status) run_status_mode ;;
  remove) run_remove_mode ;;
  guide)
    step_check_server
    step_check_hardware_and_options
    step_install_and_verify_model
    step_connect_linger
    ;;
esac
