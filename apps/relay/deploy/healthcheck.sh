#!/bin/bash
# Checks the official Relay nodes' public /healthz. Exits 1 when any node does
# not answer 200 within three tries. The addresses are the official nodes
# TeamHub lists in internal/mobilerelay.
#
#   apps/relay/deploy/healthcheck.sh            # both nodes
#   apps/relay/deploy/healthcheck.sh global     # one node
set -uo pipefail

url_of() {
  case $1 in
    global) echo "https://relay.heylinger.com/healthz" ;;
    mainland) echo "http://120.26.232.218:7787/healthz" ;;
    *) return 1 ;;
  esac
}

failed=0
for node in ${*:-global mainland}; do
  url=$(url_of "$node") || { echo "unknown node: $node" >&2; exit 2; }
  if curl -fsS --retry 2 --retry-delay 5 --retry-all-errors --max-time 10 -o /dev/null "$url"; then
    echo "$node ok ($url)"
  else
    echo "$node DOWN ($url)"
    failed=1
  fi
done
exit $failed
