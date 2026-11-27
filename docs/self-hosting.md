# Self-hosting

Run Linger from this checkout with Docker Compose instead of the desktop
app, for example to serve several computers on your network.

## Build from source

Docker Compose builds every service from this checkout and runs it, PostgreSQL
and voice included. You need Docker with Compose. Linger needs no model
gateway or API key of its own. Model calls run through a Runtime on the
user's Computer, using its configured model endpoint. Memory and personal Wiki
work on Pi runs on Pi's default model, local or your own API key. This
requires a Computer Daemon that supports Pi background calls (0.55.0 or
later), not a Codex or Claude Code login.
See [Local Inference](local-inference.md#background-memory-and-wiki) for the
background routing rules.

```bash
git clone https://github.com/simplexai-labs/linger.git
cd linger
cp .env.example .env
docker compose up --build --detach --wait
printf '%s\n' 'choose-a-password' | docker compose exec -T teamhub \
  teamhub-account create-owner --email you@example.com --password-stdin
```

Open <http://localhost:3000> and sign in. The app then shows the commands that
connect your computer, and it opens once Claude Code, Codex, Pi or Antigravity
is installed and ready there. With Pi and no model yet, open Settings › Models from
that screen and load one; Settings stays reachable while the rest of the app
waits.

To serve other computers on your network, set these in `.env`, run
`docker compose stop node-services`, then run
`docker compose up --detach --wait` again, replacing `192.168.1.10` with this
computer's address. Stopping node-services first while TeamHub is still up
puts replies in progress back in the queue instead of failing them. Browsers and Computers then reach everything through port 3000.

```bash
WEB_BIND_ADDRESS=0.0.0.0
WEB_PUBLIC_ORIGIN=http://192.168.1.10:3000
AGENT_RUNNER_PUBLIC_GATEWAY_URL=ws://192.168.1.10:3000/v1/runner-gateway
LINGER_SECRET_SEED=<output of: openssl rand -base64 32>
```

To reach the server from outside your network, see
[Remote access](remote-access.md). It covers a private tailnet, a public HTTPS
proxy, and the security values both need.

Voice needs a Soniox key; [Voice](voice.md) shows how to turn it on. To
develop on the code with hot reload instead, `pnpm dev` runs every service on
your machine against a PostgreSQL you provide; see
[Local PostgreSQL 17 for development](local-postgresql.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md).

To collect the desktop app's diagnostics from your people, run a receiver
for [Diagnostics upload](diagnostics-upload.md) and set its address as
`diagnosticsUploadUrl` in each app's `config.json`.

## Troubleshooting

| Problem                                            | What to try                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The app does not open                              | `docker compose ps`, then `docker compose logs <service>`                                                                                                        |
| The computer shows offline, or agents never answer | On that computer, `linger-computer daemon status` and `linger-computer doctor`; read `linger-computer daemon logs`, then try `linger-computer daemon restart`    |
| "No runtime is ready yet"                          | `linger-computer runtime check` lists what to install or sign in to; `linger-computer runtime check codex --live` also waits for a real model reply              |
| Other computers cannot connect                     | Set the four variables under [Build from source](#build-from-source) and run `docker compose stop node-services`, then `docker compose up --detach --wait` again |
| A device outside your network cannot reach the app | See [Remote access](remote-access.md)                                                                                                                            |
| The microphone is blocked                          | Browsers allow it only on `localhost` or HTTPS; put an HTTPS proxy in front of port 3000                                                                         |
| `pnpm dev` cannot reach the database               | `pnpm dev` starts no containers: run `docker compose up --detach --wait postgres` first, then check every service with `pnpm dev:check`                          |
