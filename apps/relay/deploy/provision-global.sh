#!/bin/bash
# EC2 user data for the global Relay node (Amazon Linux 2023). It prepares the
# machine and starts nothing: the first deploy.sh run installs the Relay and
# then starts the tunnel, so relay.heylinger.com never reaches a machine
# without a Relay behind it.
#
# The secrets come from SSM Parameter Store in this instance's region, read
# with the instance role, and are written only to root-only files here.
set -euo pipefail

CLOUDFLARED_VERSION=2026.11.1
PREFIX=/linger/relay

imds_token=$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
region=$(curl -sS -H "X-aws-ec2-metadata-token: $imds_token" http://169.254.169.254/latest/meta-data/placement/region)

parameter() {
  aws ssm get-parameter --region "$region" --name "$PREFIX/$1" --with-decryption --query Parameter.Value --output text
}

umask 077
install -d -m 700 /etc/linger-relay /etc/cloudflared
{
  echo "RELAY_HTTP_ADDRESS=127.0.0.1:8090"
  echo "RELAY_TRUSTED_PROXIES=127.0.0.1"
  echo "RELAY_PUSH_SEAL_KEY=$(parameter push-seal-key)"
  echo "RELAY_PUSH_EXPO_ACCESS_TOKEN=$(parameter expo-access-token)"
} >/etc/linger-relay/env
echo "TUNNEL_TOKEN=$(parameter tunnel-token)" >/etc/cloudflared/env

case "$(uname -m)" in
  aarch64) arch=arm64 ;;
  x86_64) arch=amd64 ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac
curl -fsSL -o /usr/local/bin/cloudflared \
  "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-$arch"
chmod 755 /usr/local/bin/cloudflared

cat >/etc/systemd/system/cloudflared.service <<'EOF'
[Unit]
Description=Cloudflare Tunnel for relay.heylinger.com
After=network-online.target linger-relay.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/cloudflared/env
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:8090
DynamicUser=yes
NoNewPrivileges=yes
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
