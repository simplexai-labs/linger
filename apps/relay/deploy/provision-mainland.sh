#!/bin/bash
# ECS user data for the mainland Relay node (Alibaba Cloud Linux 3). The node
# serves plain ws on its Elastic IP at port 7787, which needs no domain filing,
# and runs no Push Service, so it holds no secrets. The first deploy.sh run
# installs and starts the Relay.
set -euo pipefail

umask 077
install -d -m 700 /etc/linger-relay
echo "RELAY_HTTP_ADDRESS=0.0.0.0:7787" >/etc/linger-relay/env
