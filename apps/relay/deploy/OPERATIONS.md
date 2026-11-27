# Operating the official Relay nodes

Linger runs two official Relay nodes. TeamHub lists both in
`apps/teamhub/internal/mobilerelay`, and every computer keeps a link to each.
This page covers where they run, how to deploy, and how to look at them.
Self-hosting is in `../README.md`.

## Nodes

| Node     | Address                     | Where                                                                                                              |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| global   | `wss://relay.heylinger.com` | AWS `us-west-2`, EC2 instance named `linger-relay-global` (t4g.small, arm64, Amazon Linux 2023)                    |
| mainland | `ws://120.26.232.218:7787`  | Aliyun `cn-hangzhou`, ECS instance named `linger-relay-mainland` (ecs.e-c1m2.large, x86_64, Alibaba Cloud Linux 3) |

- **global** has no inbound ports. Its `cloudflared` service dials out to a
  Cloudflare Tunnel that serves `relay.heylinger.com` and forwards to the
  Relay on `127.0.0.1:8090`. This node also runs the Push Service.
- **mainland** serves plain `ws` on port 7787 of an Elastic IP named
  `linger-relay-mainland`. The IP is the address TeamHub ships, so a
  replacement machine takes over the same EIP. The node has its own VPC and a
  security group, both named `linger-relay`, that allows only TCP 7787 in.

On both machines the Relay is the systemd service `linger-relay`, running
`/opt/linger-relay/relay` with the unit in `linger-relay.service`.

## Secrets and access

The repository holds no credentials and no machine access.

- The global node's secrets are SecureString parameters under `/linger/relay/`
  in AWS SSM Parameter Store, `us-west-2`: `tunnel-token`, `push-seal-key`
  and `expo-access-token`. The instance role `linger-relay-ec2` reads them
  once at provisioning time.
- On each machine the Relay's settings are in `/etc/linger-relay/env`, and the
  tunnel token is in `/etc/cloudflared/env`. Both files are readable by root
  only. The mainland node holds no secrets.
- No machine has SSH keys or open SSH. Shell access goes through AWS Systems
  Manager and Aliyun Cloud Assistant, under the operator's cloud account.

Only someone whose own CLI credentials allow these actions can deploy:

- AWS: `ec2:DescribeInstances`, `s3:PutObject` and `s3:GetObject` on the
  `linger-relay-deploy-<account>` bucket, and `ssm:SendCommand`.
- Aliyun: ECS `DescribeInstances` and `RunCommand`, and OSS write on the
  `linger-relay-deploy-cn` bucket.

Both buckets are private and delete objects after one day.

## Deploy

Install Go, the AWS CLI and the Aliyun CLI, and sign both CLIs in. Then, from
any checkout:

```sh
apps/relay/deploy/deploy.sh            # both nodes
apps/relay/deploy/deploy.sh global     # or one node: global, mainland
```

For each node the script:

1. builds the binary for the node's architecture from the checkout;
2. uploads it to the node cloud's deploy bucket;
3. tells the machine, through SSM or Cloud Assistant, to fetch it with a
   10-minute signed URL and check its SHA-256;
4. installs `linger-relay.service`, swaps the binary in, and restarts the
   service;
5. waits for the local `/healthz`, and on the global node then makes sure
   `cloudflared` runs;
6. restores the previous binary when the new one does not come up healthy.

It ends with `healthcheck.sh` against the public addresses.

### What an update does

The Relay is one Go binary, so an update replaces it and restarts the service.
During the restart, phones connected through that node drop their Relay
session and reconnect by themselves, and computers relink within seconds.
Phones on the same network as their computer are not affected. The two nodes
are independent and the protocol stays compatible between versions, so you can
update one node and leave the other.

## Logs and restarts

Open a shell first:

- global: `aws ssm start-session --region us-west-2 --target <instance-id>`
  (find the id by the instance name), or Session Manager in the AWS console.
- mainland: Workbench or Cloud Assistant on the instance in the Aliyun ECS
  console.

Then, on either machine:

```sh
journalctl -u linger-relay -f             # Relay logs, JSON lines
journalctl -u cloudflared -f              # tunnel logs, global only
sudo systemctl restart linger-relay       # restart the Relay
sudo systemctl status linger-relay
curl -s http://127.0.0.1:8090/healthz     # global; mainland uses port 7787
```

The logs carry `relay.*` events with host IDs and byte counts only, never
payloads or client addresses.

## Health check

`healthcheck.sh` checks both public `/healthz` endpoints. The `Relay health`
GitHub workflow runs it every five minutes. On failure it opens an issue named
`Relay node down`, and it closes the issue once both nodes answer again.

## Replace a machine

1. Give the old machine another name, because the deploy script picks the
   one running instance with the node's name and refuses when there are
   several.
2. Launch the new machine with the node's name and role. Pass
   `provision-global.sh` or `provision-mainland.sh` as its user data.
3. For the global node, run `deploy.sh global` while the old machine still
   runs. The new machine joins the tunnel once its Relay is healthy. Then stop
   the old machine's `cloudflared` and Relay at once, so computers and phones
   do not land on different machines for long.
4. For the mainland node, run `deploy.sh mainland`, then move the
   `linger-relay-mainland` EIP to the new machine.
5. Stop the old machine.

## Change a node's address

Moving the EIP or the tunnel keeps the address, and nothing else changes. A
new address is a release: change the node's URL in
`apps/teamhub/internal/mobilerelay` and ship a desktop. Keep the old address
serving until then. Computers on an older desktop still link to the old
address only, and a phone that pinned the node dials only its stored copy
until a welcome through any node brings the new list. Stop the old address
once the desktops have upgraded and their phones have connected once.
