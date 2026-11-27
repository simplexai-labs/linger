# Linger Relay

The Relay lets the Linger Mobile App reach your computer when the phone is not
on the same network. Your computer keeps one outbound WebSocket open to the
Relay. When a phone dials the Relay, the computer opens a second outbound
socket for it, and the Relay forwards bytes between the two.

Everything the Relay forwards is end-to-end encrypted between the phone and
your computer. The Relay cannot read it, keeps no logs of it, and stores
nothing on disk. You can use the official Relay or run your own. Linger's own
nodes are described in `deploy/OPERATIONS.md`.

## Run it

The Relay is one static binary with no dependencies.

From source (Go 1.26):

```sh
cd apps/relay
make build
./bin/relay
```

As a container:

```sh
docker build -t linger-relay apps/relay
docker run -d --name linger-relay -p 127.0.0.1:8090:8090 linger-relay
```

`GET /healthz` answers `200 ok` when the process is up.

## Configuration

| Variable                | Default        | Meaning                                                                                                                                                             |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_HTTP_ADDRESS`    | `0.0.0.0:8090` | Address the plain HTTP server listens on.                                                                                                                           |
| `RELAY_TRUSTED_PROXIES` | empty          | Comma-separated CIDR prefixes or IP addresses of your reverse proxies. The Relay reads `X-Forwarded-For` only from these, to rate-limit by the real client address. |

Logs are JSON lines on standard output.

### Push Service (official deployment only)

The same binary runs the Push Service when these are set. A self-hosted Relay
leaves them empty: every Mobile App uses the official Push Service, because
only it holds the app's push credentials.

| Variable                       | Default                                | Meaning                                                                                       |
| ------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `RELAY_PUSH_SEAL_KEY`          | empty                                  | 32 random bytes in base64 that seal push grants. Rotating it voids every grant; phones renew. |
| `RELAY_PUSH_EXPO_ACCESS_TOKEN` | empty                                  | Expo access token; turn on enhanced push security in the Expo project. Required with the key. |
| `RELAY_PUSH_EXPO_URL`          | `https://exp.host/--/api/v2/push/send` | Expo's push endpoint.                                                                         |

## TLS

The Relay itself speaks plain HTTP. Everything it forwards is already
end-to-end encrypted and the phone pins the computer's key, so a node on an IP
address may serve plain `ws://` (the official mainland node does, because a
mainland domain needs a filing). Plain `ws://` still shows connection timing
to the networks in between; with a domain, put a TLS-terminating reverse
proxy in front and use `wss://`. With Caddy, which obtains certificates
automatically:

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:8090
}
```

Caddy forwards WebSocket upgrades without extra settings. Start the Relay with
`RELAY_TRUSTED_PROXIES=127.0.0.1` so rate limits use the address Caddy reports.
If you use another proxy, make sure it passes `Upgrade` and `Connection`
headers and does not time out idle WebSockets in under 90 seconds; the Relay
pings every 20 seconds.

## Add it as a node

The computer keeps one link to every Relay node in its list: the official
nodes plus any you add. Add yours from the phone (Settings, Relay, Add a node)
or from Settings › Phones on the computer, for example
`ws://203.0.113.7:7787` or `wss://relay.example.com`. The computer dials
`<node>/v1/host` at once, and phones learn the node on their next session and
pick the fastest node where they are (docs/adr/0005).

`TEAMHUB_MOBILE_RELAY_URL` also adds a node when TeamHub starts; set empty, it
turns every Relay link off.

## Spare data sockets

A computer that offers it keeps one idle data socket open to the Relay, so a
phone that connects is spliced at once instead of waiting for the computer to
dial in. Older computers and Relays skip this and use the `open` flow.

## Limits

- 70,000 bytes per message.
- 256 KiB held for a phone before the computer's socket arrives.
- 16 open phone links per computer.
- 30 phone dials and 10 computer dials per minute per client address.
- A socket silent for 60 seconds is closed.
