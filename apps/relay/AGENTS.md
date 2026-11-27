# Relay: forwarding-only splice between phones and computers

The Relay joins a phone's WebSocket to a data WebSocket the computer's Mobile
Gateway dials out on demand, then forwards binary messages both ways. The
protocol is specified in `docs/mobile.md` ("Relay protocol"); the computer-side
client is `apps/teamhub/internal/mobilegateway/transport.go`. Anyone may
self-host it; see `README.md`.

## Common Commands

- `make -C apps/relay check`: gofmt check, `go vet`, and `go test -race`.
- `make -C apps/relay build`: build `bin/relay`.
- `docker build apps/relay`: build the container image.

## Structure

- `cmd/relay`: process entry, signal handling, graceful shutdown.
- `internal/config`: the only place that reads the environment
  (`RELAY_*`).
- `internal/relay`: HTTP routes, host proof, splice, rate limits.
- `deploy`: the official nodes' systemd unit, provisioning user data,
  `deploy.sh`, `healthcheck.sh`, and the runbook `OPERATIONS.md`.
- `internal/push`: the Push Service (`/v1/push/grants`, `/v1/push/send`),
  mounted only when `RELAY_PUSH_SEAL_KEY` is set. It seals push grants with
  XChaCha20-Poly1305 and sends content-free alerts through Expo.

## Invariants

- Forwarded messages are opaque end-to-end encrypted bytes. Never parse,
  inspect, or transform them.
- Store nothing beyond memory: online hosts, pending links, rate-limit
  buckets. No database, no files.
- Never log payload bytes, tickets, proofs, keys, or client addresses. Log
  `relay.*` events with `host_id`, `conn`, and byte counters only.
- Each socket has one reader goroutine handing messages over an unbuffered
  channel, so memory per splice stays bounded; the only buffer is the phone's
  pre-splice hold.
- Limits are constants in `internal/relay/relay.go` and must match
  `docs/mobile.md`: 70,000 bytes per message, 256 KiB pre-splice hold, 16 phone
  links per host, 30 phone dials and 10 host dials per minute per client
  address, 20-second pings, 60-second silence timeout, 10-second hello and open
  timeouts.
- The Push Service stores nothing either: a grant carries the Expo token,
  Host ID and expiry sealed under the service key, and quotas live in memory.
  Alert text names only the event kind. Never log tokens or grants.
- Close codes: `4404` host offline, `4408` host did not answer, `4413` message
  too large, `4429` too many phone links. Rate-limited dials get HTTP 429 before
  the upgrade.
- Do not import from other `apps/*`; tests carry their own fake host.
