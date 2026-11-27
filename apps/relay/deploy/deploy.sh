#!/bin/bash
# Builds the Relay from this checkout and deploys it to the official nodes:
#
#   apps/relay/deploy/deploy.sh            # both nodes
#   apps/relay/deploy/deploy.sh mainland   # one node: global or mainland
#
# It uses the operator's own AWS and Aliyun CLI credentials; the repository
# holds none. The binary goes to a private bucket in the node's cloud, the node
# fetches it through a 10-minute signed URL, checks its SHA-256, swaps it in,
# restarts linger-relay and rolls back if /healthz does not answer. Nodes are
# found by name, so a replaced machine needs no change here. OPERATIONS.md
# describes the nodes.
set -euo pipefail

AWS_REGION=${RELAY_DEPLOY_AWS_REGION:-us-west-2}
ALIYUN_REGION=${RELAY_DEPLOY_ALIYUN_REGION:-cn-hangzhou}
OSS_BUCKET=${RELAY_DEPLOY_OSS_BUCKET:-linger-relay-deploy-cn}

here=$(cd "$(dirname "$0")" && pwd)
relay_dir=$(dirname "$here")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
revision=$(git -C "$relay_dir" rev-parse --short=8 HEAD)
if [ -n "$(git -C "$relay_dir" status --porcelain -- .)" ]; then
  revision="$revision-dirty"
fi

build() {
  local arch=$1
  (cd "$relay_dir" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -trimpath -ldflags="-s -w" -o "$work/relay-$arch" ./cmd/relay)
}

sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }

# remote_script URL SHA prints the script a node runs. It keeps the previous
# binary and restores it when the new one does not come up healthy.
remote_script() {
  local unit
  unit=$(base64 <"$here/linger-relay.service" | tr -d '\n')
  cat <<EOF
set -euo pipefail
install -d -m 755 /opt/linger-relay
cd /opt/linger-relay
curl -fsS --retry 3 -o relay.new '$1'
echo '$2  relay.new' | sha256sum -c --quiet
chmod 755 relay.new
echo '$unit' | base64 -d >/etc/systemd/system/linger-relay.service
systemctl daemon-reload
systemctl enable --quiet linger-relay
[ -f relay ] && cp -p relay relay.prev
mv relay.new relay
systemctl restart linger-relay
address=\$(sed -n 's/^RELAY_HTTP_ADDRESS=//p' /etc/linger-relay/env)
health="http://127.0.0.1:\${address##*:}/healthz"
for _ in \$(seq 20); do
  if curl -fsS --max-time 2 "\$health" >/dev/null 2>&1; then
    if [ -f /etc/systemd/system/cloudflared.service ]; then systemctl enable --now --quiet cloudflared; fi
    echo "linger-relay healthy"
    exit 0
  fi
  sleep 1
done
echo "linger-relay did not become healthy; rolling back" >&2
if [ -f relay.prev ]; then mv relay.prev relay; systemctl restart linger-relay; fi
exit 1
EOF
}

deploy_global() {
  local instance account bucket key url status
  instance=$(aws ec2 describe-instances --region "$AWS_REGION" \
    --filters Name=tag:Name,Values=linger-relay-global Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  [ -n "$instance" ] || { echo "global: no running linger-relay-global in $AWS_REGION" >&2; return 1; }
  account=$(aws sts get-caller-identity --query Account --output text)
  bucket="linger-relay-deploy-$account"
  build arm64
  key="relay-$revision-arm64"
  aws s3 cp --quiet "$work/relay-arm64" "s3://$bucket/$key" --region "$AWS_REGION"
  url=$(aws s3 presign "s3://$bucket/$key" --region "$AWS_REGION" --expires-in 600)
  remote_script "$url" "$(sha256 "$work/relay-arm64")" |
    python3 -c 'import json,sys; print(json.dumps({"commands": [sys.stdin.read()]}))' >"$work/global.json"
  local command
  command=$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$instance" \
    --document-name AWS-RunShellScript --comment "linger-relay $revision" \
    --parameters "file://$work/global.json" --query Command.CommandId --output text)
  aws ssm wait command-executed --region "$AWS_REGION" --command-id "$command" --instance-id "$instance" || true
  status=$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command" --instance-id "$instance" \
    --query '[Status, StandardOutputContent, StandardErrorContent]' --output text)
  echo "global ($instance): $status"
  [[ $status == Success* ]]
}

deploy_mainland() {
  local instance key url invoke result
  instance=$(aliyun ecs DescribeInstances --RegionId "$ALIYUN_REGION" --InstanceName linger-relay-mainland --Status Running |
    python3 -c 'import json,sys; print(" ".join(i["InstanceId"] for i in json.load(sys.stdin)["Instances"]["Instance"]))')
  [ -n "$instance" ] || { echo "mainland: no running linger-relay-mainland in $ALIYUN_REGION" >&2; return 1; }
  build amd64
  key="relay-$revision-amd64"
  aliyun oss cp "$work/relay-amd64" "oss://$OSS_BUCKET/$key" -f --region "$ALIYUN_REGION" \
    -e "oss-$ALIYUN_REGION.aliyuncs.com" >/dev/null
  url=$(aliyun oss sign "oss://$OSS_BUCKET/$key" --timeout 600 --region "$ALIYUN_REGION" \
    -e "oss-$ALIYUN_REGION-internal.aliyuncs.com" | head -1)
  invoke=$(aliyun ecs RunCommand --RegionId "$ALIYUN_REGION" --InstanceId.1 "$instance" \
    --Type RunShellScript --ContentEncoding Base64 --Timeout 120 --Name "linger-relay $revision" \
    --CommandContent "$(remote_script "$url" "$(sha256 "$work/relay-amd64")" | base64 | tr -d '\n')" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["InvokeId"])')
  for _ in $(seq 60); do
    sleep 3
    result=$(aliyun ecs DescribeInvocationResults --RegionId "$ALIYUN_REGION" --InvokeId "$invoke" |
      python3 -c '
import base64, json, sys
r = json.load(sys.stdin)["Invocation"]["InvocationResults"]["InvocationResult"][0]
if r["InvocationStatus"] in ("Pending", "Running"):
    print("running")
else:
    print(r["InvocationStatus"], base64.b64decode(r.get("Output") or "").decode(errors="replace").strip())')
    [ "$result" = running ] || break
  done
  echo "mainland ($instance): $result"
  [[ $result == Success* ]]
}

nodes=${*:-global mainland}
failed=0
for node in $nodes; do
  case $node in
    global) deploy_global || failed=1 ;;
    mainland) deploy_mainland || failed=1 ;;
    *) echo "unknown node: $node (use global or mainland)" >&2; exit 2 ;;
  esac
done
"$here/healthcheck.sh" $nodes || failed=1
exit $failed
