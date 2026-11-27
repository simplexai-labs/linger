# Remote access

Reach Linger from a phone or another computer while the agent and its data stay
on your own machine. Nothing is exposed by default.

The desktop app's built-in server listens on loopback only and has no remote
access setting. To reach Linger from another device, run the
[Docker Compose install](self-hosting.md#build-from-source) on the machine that
holds your data. The Web app runs there, and the Computer you connect can be
that machine too. The other device opens the same app over a private tunnel or
HTTPS. The desktop app can then connect to that server instead of running its
own.

This page covers two paths. Use the first unless you need a public address, and
keep the tunnel or proxy you already run if you have one.

## Before either path

- Create the owner account with a password you do not use anywhere else.
- For a new install, generate a private `LINGER_SECRET_SEED` with
  `openssl rand -base64 32` and keep it in the ignored `.env`. For an existing
  install, keep its current private seed. TeamHub rejects the public
  development seed when `WEB_PUBLIC_ORIGIN` is not loopback.
- Keep an existing private `TEAMHUB_SECRET_ENCRYPTION_KEY` unchanged. If the
  install still uses the public default from `.env.example`, generate a private
  key with `openssl rand -base64 32`. Changing the key makes saved API keys
  unreadable until you save them again in Linger.
- Keep `WEB_BIND_ADDRESS` at its default `127.0.0.1` unless the proxy runs on
  another host, as Path B describes. The tunnel or proxy reaches the Web port
  locally, so no other port needs to be reachable.
- Set `WEB_PUBLIC_ORIGIN` and `AGENT_RUNNER_PUBLIC_GATEWAY_URL` to the address
  your devices use. The first is the browser origin; the second is the
  `wss://` gateway a Computer dials.
- Restart with `docker compose stop node-services` and then
  `docker compose up --detach --wait`, so replies in progress return to the
  queue.

## Path A: a private tailnet (recommended)

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) gives
the server an HTTPS name that only devices in your tailnet can open. It needs
no open inbound port, no DNS record, and no certificate to manage.

1. Install Tailscale on the server and on the phone or other device, and sign
   both in to the same tailnet.
2. In the checkout on the server, set these in `.env`:

   ```bash
   WEB_PUBLIC_ORIGIN=https://linger-laptop.example-tailnet.ts.net
   AGENT_RUNNER_PUBLIC_GATEWAY_URL=wss://linger-laptop.example-tailnet.ts.net/v1/runner-gateway
   ```

   Use the name that `tailscale status` prints for the server. Keep the
   `https://` scheme on the origin and the `/v1/runner-gateway` path on the
   gateway. Keep existing private secret values from the section above. For a
   new install, generate both values there before starting Linger.

3. Restart Linger as described above.
4. On the server, proxy the Web port into the tailnet:

   ```bash
   tailscale serve --bg 3000
   tailscale serve status
   ```

   The command prints the HTTPS address. Approve the prompt that enables
   HTTPS certificates for your tailnet if it appears. Use `--bg` so it resumes
   after a restart, and use your `WEB_HTTP_PORT` instead of `3000` if you
   changed it.

5. Open the printed address on the other device and sign in. Add it to the
   home screen to install the PWA.

`tailscale serve` is private to the tailnet. `tailscale funnel` publishes the
same port to the public internet; do not run it for this setup. Tailnet access
rules still apply, so share the device only with people you trust.

To stop sharing, run `tailscale serve reset`. It removes every Serve entry on
that machine.

## Path B: a public HTTPS reverse proxy

Use this when the address must work for a device that cannot join a tailnet,
for example a browser you do not control. You need a domain name and a proxy
on the server or on the network in front of it.

1. Point a DNS name at the server and put an HTTPS proxy in front of the Web
   port. Caddy is one option; its default configuration gets a certificate:

   ```caddyfile
   linger.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Any proxy works if it forwards WebSocket upgrades for
   `/v1/runner-gateway`, `/document-collaboration`, and the other service
   paths. For nginx, set `proxy_http_version 1.1` and forward the `Upgrade`
   and `Connection` headers.

2. Set `WEB_PUBLIC_ORIGIN` to `https://linger.example.com` and
   `AGENT_RUNNER_PUBLIC_GATEWAY_URL` to
   `wss://linger.example.com/v1/runner-gateway`.
3. Open only ports 80 and 443 on the firewall. If the proxy runs on the same
   host, keep the Web port on loopback. If it runs on another host, put both
   on a private network, set `WEB_BIND_ADDRESS` to that network's address, and
   firewall the Web port to the proxy only.
4. Keep PostgreSQL and the Node services off the public network.

A public address is reachable by anyone who finds it. Use a long, unique owner
password, keep the proxy and Linger updated, and review the proxy's access
logs. If the address leaks, change the owner password from a device you trust in
**Settings > Security**. That signs out every other session and keeps the
current one.

If you already run a tunnel or proxy, use it. Set the two public addresses
above and route the tunnel or proxy to the Web port. If the proxy runs on
another host, keep that port on a private network and allow access from the
proxy only.

## What works remotely

The Web app, Rooms, Documents, Tasks, file uploads, and notifications work
over either path. The PWA needs HTTPS, which both paths provide.

Voice from another device needs more than this: the microphone needs HTTPS,
and the browser connects to the LiveKit server directly. The Compose file
publishes LiveKit on loopback only. Test a real recording before you rely on
it; [Voice](voice.md) covers the keys and ports.

## Ask your agent

An agent can read this page and walk you through the steps. It can change the
server's `.env` and tunnel settings only when it runs on the server host, so
confirm before it changes anything that exposes a port.

## Troubleshooting

| Problem                                                  | What to try                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The address does not open                                | Run `tailscale serve status` or read the proxy log, and confirm the Web port answers on `127.0.0.1` on the server.              |
| The app cannot complete sign-in or API requests          | Check that `WEB_PUBLIC_ORIGIN` matches the browser origin. TeamHub derives its CORS and secure-cookie settings from this value. |
| A Computer shows offline                                 | `AGENT_RUNNER_PUBLIC_GATEWAY_URL` does not match the address the Computer can reach, or the proxy drops WebSocket upgrades.     |
| The browser cannot install the PWA or use the microphone | The address is not HTTPS.                                                                                                       |
