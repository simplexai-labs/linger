#!/bin/sh
set -eu

# >>> release pin
STACK_VERSION='0.1.0.dev56'
STACK_SOURCE_COMMIT='8ecf4bb328e1798ff166f1f48919b3b6c3c64270'
STACK_NPM_VERSION='0.1.0-dev.56'
# shellcheck disable=SC2034
STACK_RUNTIMES='claude=2.1.325 codex=0.171.0 pi=1.5.2'
# shellcheck disable=SC2034
STACK_RUNTIME_BASELINES='claude=2.1.282 codex=0.166.0 pi=1.2.0'
STACK_KIT_darwin_arm64='fea3eb395f64a04241d97777a8e2d6522127bb37cf86c7adbdba3b3db858f779'
STACK_KIT_darwin_x64='775c54a3878f695c807b11aa471b5b674fea5912484e79cf3149dd72a0f7b840'
STACK_KIT_linux_arm64='7dfa96374fa86842bc8b8e19d132e6c1483a494926d093898ba43143330fd173'
STACK_KIT_linux_x64='0cf9b7e2fe80f7fdd21d3493ca20d32b81c206f5ddce8abaa7a61fb7d2d9c648'
# <<< release pin

die() {
  printf 'stack.sh: %s\n' "$1" >&2
  exit 2
}

[ -n "${STACK_VERSION}" ] || die 'this is the unpinned template; use a released launcher'
region=${SIMPLEX_REGION:-auto}
if [ "${1:-}" = --region ]; then
  [ "$#" -ge 2 ] || die '--region requires auto, global or cn'
  region=$2
  shift 2
fi
case "$region" in auto | global | cn) ;; *) die '--region requires auto, global or cn' ;; esac
bootstrap=false
installed_only=false
if [ "${1:-}" = --bootstrap-json ]; then
  bootstrap=true
  shift
  if [ "${1:-}" = --installed-only ]; then installed_only=true; shift; fi
  [ "$#" -eq 0 ] || die 'usage: --bootstrap-json [--installed-only]'
elif [ "${1:-}" = --installed-only ]; then
  die '--installed-only requires --bootstrap-json'
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64) target=linux-x64; kit=${STACK_KIT_linux_x64} ;;
  Linux-aarch64 | Linux-arm64) target=linux-arm64; kit=${STACK_KIT_linux_arm64} ;;
  Darwin-arm64) target=darwin-arm64; kit=${STACK_KIT_darwin_arm64} ;;
  Darwin-x86_64) target=darwin-x64; kit=${STACK_KIT_darwin_x64} ;;
  *) die 'no localmodels kit for this platform; on Windows use stack.ps1' ;;
esac
[ -n "${kit}" ] || die "release ${STACK_VERSION} has no ${target} kit"
manifest='' inventory='' bytes='' files='' entries='' python='' modules=''
# >>> bootstrap targets
case "$target" in
  darwin-arm64) manifest='25ad98fae5b21722b7de0e103c5764a555d6a2554409ecab9f86dd2776d87164'; inventory='c61cb13bfd828d155b9f023633f421113c44d642392cf2e55912ff90869ec3c2'; bytes='15056583'; files='1383'; entries='1523'; python='python/bin/python3.12'; modules='modules' ;;
  darwin-x64) manifest='e1cb60c58de1d85e7fa10fe70af8196e5fde0b396a317e1f943d935babf7cbb0'; inventory='abd2e0b30f795c29440563030f7a695f009a071be797b6c4a3f154adad978626'; bytes='14885432'; files='1380'; entries='1519'; python='python/bin/python3.12'; modules='modules' ;;
  linux-arm64) manifest='4725673b85b6f30afe855f7143b3d467549446c3cd6e45a7679202e263d15291'; inventory='7eff65222245f0ddb0944a646ed2111f749587de17bbdc3230395696fdd96295'; bytes='17565374'; files='4254'; entries='4438'; python='python/bin/python3.12'; modules='modules' ;;
  linux-x64) manifest='4f5157c97d7c792caf4751761348fdc00c7e5f81aae894e74c94de343a8ef1eb'; inventory='677b57e9579fc3de4a3f2ff1f32108997934edfbf7efdc5bbab507e1cb8b187b'; bytes='20892220'; files='4254'; entries='4438'; python='python/bin/python3.12'; modules='modules' ;;
  *) die 'release lacks bootstrap pins' ;;
esac
# <<< bootstrap targets
[ -n "$inventory" ] || die 'release lacks bootstrap pins'

root=${LOCALMODELS_KIT_HOME:-${XDG_CACHE_HOME:-${HOME}/.cache}/simplex-localmodels/kits}
case "$root" in /*) ;; *) root=$PWD/$root ;; esac
while [ "$root" != / ] && [ "${root%/}" != "$root" ]; do root=${root%/}; done
final=$root/$kit
owner=$(id -u)
staging=''
lock=''
child=''

cleanup() {
  if [ -n "$child" ]; then kill "$child" 2>/dev/null || :; wait "$child" 2>/dev/null || :; fi
  if [ -n "$staging" ]; then
    find "$staging" -type d -user "$owner" -exec chmod 0700 {} + 2>/dev/null || :
    rm -rf "$staging" 2>/dev/null || printf 'stack.sh: staging cleanup failed\n' >&2
  fi
  if [ -n "$lock" ]; then rmdir "$lock" 2>/dev/null || :; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sha256_of() (
  if [ "$1" != - ]; then exec < "$1"; fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d ' ' -f 1
  else
    die 'sha256sum or shasum is required'
  fi
)

private_root() {
  [ -d "$root" ] && [ ! -L "$root" ] &&
    [ -z "$(find "$root" -prune \( ! -user "$owner" -o -perm -0040 -o -perm -0020 -o -perm -0010 -o -perm -0004 -o -perm -0002 -o -perm -0001 \) -print)" ] || return 1
  ancestor=$(dirname "$root")
  while :; do
    [ ! -L "$ancestor" ] || return 1
    bad_parent=$(find "$ancestor" -prune \( \( ! -user "$owner" ! -user 0 \) -o \( \( -perm -0020 -o -perm -0002 \) ! -perm -1000 \) \) -print) || return 1
    [ -z "$bad_parent" ] || return 1
    [ "$ancestor" != / ] || break
    ancestor=$(dirname "$ancestor")
  done
}

verify_tree() (
  directory=$1
  [ -d "$directory" ] && [ ! -L "$directory" ] || exit 1
  bad=$(find "$directory" \( ! -user "$owner" -o ! \( -type d -o -type f \) -o \( -type d ! -perm 0700 \) -o \( -type f ! \( -perm 0600 -o -perm 0700 \) \) -o \( -type f -links +1 \) \) -print) || exit 1
  [ -z "$bad" ] || exit 1
  [ -x "$directory/$python" ] || exit 1
  [ "$(find "$directory" -type f | wc -l | tr -d ' ')" = "$files" ] || exit 1
  [ "$(find "$directory" | wc -l | tr -d ' ')" = "$entries" ] || exit 1
  [ "$(sha256_of "$directory/bootstrap.sha256")" = "$inventory" ] || exit 1
  [ "$(sha256_of "$directory/tool.json")" = "$manifest" ] || exit 1
  [ "$(cat "$directory/bootstrap.identity")" = "$target $STACK_SOURCE_COMMIT $STACK_VERSION $python $modules" ] || exit 1
  platform=${target%-*}
  arch=${target##*-}
  prefix="{\"schemaVersion\":1,\"platform\":\"$platform\",\"arch\":\"$arch\",\"sourceCommit\":\"$STACK_SOURCE_COMMIT\",\"python\":\"$python\",\"moduleDir\":\"$modules\""
  reconstructed=$(LC_ALL=C awk -v prefix="$prefix" '
    BEGIN {printf "%s,\"assets\":{", prefix}
    $2!="tool.json" && $2!="bootstrap.identity" {
      if(n++) printf ","
      printf "\"%s\":\"%s\"", $2, $1
    }
    END {printf "}}"}
  ' "$directory/bootstrap.sha256" | sha256_of -)
  [ "$reconstructed" = "$manifest" ] || exit 1
  cd "$directory"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c bootstrap.sha256 >/dev/null 2>&1
  else
    shasum -a 256 -c bootstrap.sha256 >/dev/null 2>&1
  fi
) 2>/dev/null

curl_protocol() {
  case "$1" in
    http://127.0.0.1:* | http://localhost:*)
      if [ -n "${SIMPLEX_NPM_REGISTRY:-}${LOCALMODELS_KIT_BASE_URL:-}" ]; then
        printf '=http,https'
        return
      fi ;;
  esac
  printf '=https'
}

select_downloader() {
  if command -v curl >/dev/null 2>&1; then
    downloader=curl
    return
  fi
  downloader=wget
  wget_requirement='curl or GNU Wget is required; BusyBox wget cannot restrict redirects to HTTPS (on Alpine: apk add curl)'
  wget_version=$(wget --version 2>/dev/null) || wget_version=''
  case "$wget_version" in *'GNU Wget'*) ;; *) die "$wget_requirement" ;; esac
  wget_help=$(wget --help 2>/dev/null) || wget_help=''
  for wget_option in --https-only --max-redirect --server-response --ca-certificate; do
    case "$wget_help" in *"$wget_option"*) ;; *) die "$wget_requirement" ;; esac
  done
}

wget_secure() {
  wget_url=$1 wget_output=$2 wget_timeout=$3 wget_range=${4:-}
  wget_hops=0 wget_child=''
  wget_headers=$(mktemp "$staging/.wget-headers.XXXXXX") || return 1
  trap 'if [ -n "$wget_child" ]; then kill "$wget_child" 2>/dev/null || :; wait "$wget_child" 2>/dev/null || :; fi; rm -f "$wget_headers"' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  while :; do
    case "$wget_url" in
      https://*) ;;
      http://127.0.0.1:* | http://localhost:*) [ "$wget_hops" -eq 0 ] && [ "$(curl_protocol "$wget_url")" = '=http,https' ] || return 1 ;;
      *) return 1 ;;
    esac
    wget_authority=${wget_url#*://}; wget_authority=${wget_authority%%/*}
    case "$wget_authority" in *@*) return 1 ;; esac
    set -- --https-only --max-redirect=0 --server-response --tries=1 --timeout="$wget_timeout" -O "$wget_output"
    if [ -n "${SSL_CERT_FILE:-}" ]; then set -- --ca-certificate "$SSL_CERT_FILE" "$@"; fi
    if [ "$wget_range" = range ]; then set -- --header='Range: bytes=0-262143' "$@"; fi
    wget "$@" "$wget_url" 2>"$wget_headers" &
    wget_child=$! wget_status=0
    wait "$wget_child" || wget_status=$?
    wget_child=''
    [ "$wget_status" -ne 0 ] || return 0
    wget_code=$(LC_ALL=C awk '/^[[:space:]]*HTTP\// {code=$2} END {print code}' "$wget_headers")
    case "$wget_code" in 301 | 302 | 303 | 307 | 308) ;; *) return "$wget_status" ;; esac
    [ "$wget_hops" -lt 5 ] || return 1
    wget_location=$(LC_ALL=C awk 'tolower($1)=="location:" {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); target=$0} END {print target}' "$wget_headers")
    case "$wget_location" in
      https://*) wget_url=$wget_location ;;
      //*) wget_url=https:$wget_location ;;
      /*) wget_url=$(printf '%s' "$wget_url" | cut -d / -f 1-3)$wget_location ;;
      *://* | '') return 1 ;;
      *) wget_url=${wget_url%/*}/$wget_location ;;
    esac
    wget_hops=$((wget_hops + 1))
  done
}

fetch() {
  if [ "$downloader" = curl ]; then
    (ulimit -f "$(( (bytes + 511) / 512 ))"; exec curl -q -fsSL --proto "$(curl_protocol "$1")" --proto-redir '=https' --max-redirs 5 --retry 2 --connect-timeout 15 --max-time 300 --max-filesize "$bytes" -o "$2" "$1") 2>/dev/null &
  else
    (ulimit -f "$(( (bytes + 511) / 512 ))"; wget_secure "$1" "$2" 300) 2>/dev/null &
  fi
  child=$!
  status=0
  wait "$child" || status=$?
  child=''
  return "$status"
}

npm_url() {
  case "$1" in
    cn) base=https://registry.npmmirror.com ;;
    global) base=https://registry.npmjs.org ;;
  esac
  base=${SIMPLEX_NPM_REGISTRY:-$base}
  name=localmodels-$target
  printf '%s/@simplexai/%s/-/%s-%s.tgz\n' "${base%/}" "$name" "$name" "$STACK_NPM_VERSION"
}

probe() (
  if [ "$downloader" = curl ]; then
    url=$(npm_url "$1")
    curl -q -fsSL --proto "$(curl_protocol "$url")" --proto-redir '=https' --max-redirs 5 --range 0-262143 --max-time 5 -o /dev/null "$url" 2>/dev/null || exit 0
  else
    wget_secure "$(npm_url "$1")" /dev/null 5 range 2>/dev/null || exit 0
  fi
  if mkdir "$staging/winner" 2>/dev/null; then printf '%s\n' "$1" > "$staging/winner/region"; fi
)

resolve_region() {
  if [ "$region" = auto ] && [ -n "${LOCALMODELS_KIT_BASE_URL:-}" ]; then region=global; fi
  if [ "$region" = auto ]; then
    probe global & global_probe=$!
    probe cn & cn_probe=$!
    (sleep 5; kill "$global_probe" "$cn_probe" 2>/dev/null || :) & probe_timer=$!
    wait "$global_probe" || :
    wait "$cn_probe" || :
    kill "$probe_timer" 2>/dev/null || :
    wait "$probe_timer" 2>/dev/null || :
    region=global
    if [ -f "$staging/winner/region" ]; then region=$(cat "$staging/winner/region"); fi
  fi
  printf 'stack.sh: using npm mirror %s (%s)\n' "$(npm_url "$region" | cut -d / -f 3)" "$region" >&2
}

install_kit() {
  umask 077
  if [ ! -e "$root" ] && [ ! -L "$root" ]; then
    mkdir -p "$root" 2>/dev/null || die 'could not create cache root'
  fi
  # shellcheck disable=SC2015  # die exits, so "A && B || die" is a guard
  [ -d "$root" ] && [ ! -L "$root" ] &&
    [ -z "$(find "$root" -prune ! -user "$owner" -print)" ] || die 'cache root must be an owned directory'
  chmod 0700 "$root" 2>/dev/null || die 'could not protect cache root'
  private_root || die 'cache root must be a private owned directory'
  attempts=0
  while ! mkdir "$root/.lock-$kit" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 120 ] || die 'cache lock timeout; retry after the other bootstrap exits'
    sleep 1 &
    child=$!
    wait "$child"
    child=''
  done
  lock=$root/.lock-$kit
  if verify_tree "$final"; then return; fi
  if [ -e "$final" ] || [ -L "$final" ]; then
    # shellcheck disable=SC2015  # die exits, so "A && B || die" is a guard
    [ -d "$final" ] && [ ! -L "$final" ] || die 'cache kit must be an owned directory'
    [ -z "$(find "$final" -prune ! -user "$owner" -print)" ] || die 'cache kit must be an owned directory'
  fi
  staging=$(mktemp -d "$root/.staging.XXXXXX") || die 'could not create staging directory'
  select_downloader
  printf 'stack.sh: downloading localmodels %s\n' "$STACK_VERSION" >&2
  resolve_region
  if [ -n "${LOCALMODELS_KIT_BASE_URL:-}" ]; then
    fetch "${LOCALMODELS_KIT_BASE_URL%/}/${target}.tgz" "$staging/kit.tgz" || die 'download failed'
  elif ! fetch "$(npm_url "$region")" "$staging/kit.tgz"; then
    if [ "$region" = cn ]; then region=global; else region=cn; fi
    fetch "$(npm_url "$region")" "$staging/kit.tgz" || die 'download failed from both npm registries'
  fi
  # shellcheck disable=SC2015  # die exits, so "A && B || die" is a guard
  [ "$(wc -c < "$staging/kit.tgz" | tr -d ' ')" = "$bytes" ] &&
    [ "$(sha256_of "$staging/kit.tgz")" = "$kit" ] || die 'archive SHA256 mismatch or size mismatch'
  tar -tzf "$staging/kit.tgz" > "$staging/names" 2>/dev/null || die 'invalid kit archive'
  LC_ALL=C awk '
    !/^package\// {exit 1}
    /[^A-Za-z0-9_.+\/-]/ {exit 1}
    /^\// {exit 1}
    {sub(/\/$/, ""); n=split($0,p,"/"); for(i=1;i<=n;i++)
      if(p[i]=="" || p[i]=="." || p[i]==".." || p[i]~/\.$/ ||
        tolower(p[i])~/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/) exit 1}
  ' "$staging/names" || die 'unsafe kit archive path'
  tar -tvzf "$staging/kit.tgz" > "$staging/members" 2>/dev/null || die 'invalid kit archive'
  LC_ALL=C awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}' "$staging/members" || die 'linked or special kit archive member'
  size_column=3
  [ "$(uname -s)" != Darwin ] || size_column=5
  LC_ALL=C awk -v column="$size_column" '
    $column !~ /^[0-9]+$/ {exit 1}
    {size+=$column; if(size>1073741824) exit 1}
  ' "$staging/members" || die 'kit archive exceeds extracted size limit'
  mkdir "$staging/kit" 2>/dev/null || die 'could not create kit directory'
  tar -xzf "$staging/kit.tgz" --strip-components=1 -C "$staging/kit" 2>/dev/null &
  child=$!
  wait "$child" || die 'could not unpack kit'
  child=''
  chmod 0700 "$staging/kit/$python" "$staging/kit/kit.py" 2>/dev/null || die 'could not restore executables'
  find "$staging/kit" -type f -exec chmod u+rw,go-rwx {} + 2>/dev/null || die 'could not protect kit files'
  find "$staging/kit" -type d -exec chmod 0700 {} + 2>/dev/null || die 'could not protect kit directories'
  verify_tree "$staging/kit" || die 'downloaded kit failed verification'
  if [ -e "$final" ]; then
    chmod u+w "$final" 2>/dev/null || die 'could not reopen damaged kit'
    mv "$final" "$staging/invalid" 2>/dev/null || die 'could not quarantine damaged kit'
  fi
  mv "$staging/kit" "$final" 2>/dev/null || die 'could not activate kit'
}

if ! private_root || ! verify_tree "$final"; then
  "$installed_only" && die 'installed kit validation failed'
  install_kit
fi
cleanup
staging=''
lock=''
SIMPLEX_REGION=$region
export SIMPLEX_REGION
final=$(cd "$final" && pwd -P) || die 'could not resolve verified kit location'
if "$bootstrap"; then
  exec "$final/$python" -I -B "$final/kit.py" describe "$STACK_VERSION" "$target" \
    "$STACK_SOURCE_COMMIT" "$kit" "$manifest" "$python" "$modules"
fi
[ "$#" -gt 0 ] || set -- --help
exec "$final/$python" -I -B "$final/kit.py" run stack "$@"
