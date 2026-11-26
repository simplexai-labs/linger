#!/bin/sh
# Runs the bundled teamhub CLI with the Node built into Linger.
dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
app="$dir/../../../../MacOS/Linger"
[ -x "$app" ] || app="$dir/../../../../Linger.exe"
[ -x "$app" ] || app="$dir/../../../../linger"
[ -x "$app" ] || app="${LINGER_NODE:-node}"
script="$dir/teamhub.js"
case "$app" in
  *.exe)
    # WSL passes Linux paths as literal Windows arguments and only carries
    # explicitly listed Linux environment variables to Windows executables.
    if command -v wslpath >/dev/null 2>&1; then
      script=$(wslpath -w "$script") || exit 1
      wslenv_remove() {
        name=$1
        rest=${WSLENV:-}
        out=""
        while [ -n "$rest" ]; do
          case "$rest" in
            *:*)
              item=${rest%%:*}
              rest=${rest#*:}
              ;;
            *)
              item=$rest
              rest=""
              ;;
          esac
          case "$item" in
            ""|"$name"|"$name"/*) ;;
            *) out="${out:+$out:}$item" ;;
          esac
        done
        WSLENV=$out
      }
      wslenv_add() {
        wslenv_remove "$1"
        WSLENV="${WSLENV:+$WSLENV:}$1"
      }
      wslenv_add ELECTRON_RUN_AS_NODE
      wslenv_add WSL_DISTRO_NAME
      if [ -n "${TEAMHUB_CONFIG:-}" ]; then
        case "$TEAMHUB_CONFIG" in
          [A-Za-z]:/*|[A-Za-z]:\\*|\\\\*) ;;
          *) TEAMHUB_CONFIG=$(wslpath -w "$TEAMHUB_CONFIG") || exit 1 ;;
        esac
        export TEAMHUB_CONFIG
        wslenv_add TEAMHUB_CONFIG
      else
        unset TEAMHUB_CONFIG
        wslenv_remove TEAMHUB_CONFIG
      fi
      if [ -n "${TEAMHUB_PROFILE:-}" ]; then
        export TEAMHUB_PROFILE
        wslenv_add TEAMHUB_PROFILE
      else
        unset TEAMHUB_PROFILE
        wslenv_remove TEAMHUB_PROFILE
      fi
      export WSLENV
    fi
    ;;
esac
ELECTRON_RUN_AS_NODE=1 exec "$app" --use-env-proxy "$script" "$@"
