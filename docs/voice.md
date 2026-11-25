# Voice

**Record a whole meeting with a live transcript, hand off tasks by voice, or
keep talking to an agent hands-free.**

![A meeting recorder with a live transcript, an Ask tab that answers from what was said and sends requests to Another Me, and the recording, transcript and follow-up draft landing in the Another Me chat](../assets/feature-voice.jpg)

## Turning voice on

Voice runs wherever the deployment can run it: TeamHub's
`TEAMHUB_VOICE_MEDIA` is `on` (the default), `LINGER_SECRET_SEED` is set, and
`ffmpeg` and `ffprobe` are on `PATH`. `TEAMHUB_VOICE_MEDIA=off`, a missing seed,
or missing ffmpeg keep voice off; TeamHub still starts and logs
`voice.media_unavailable` for the last two.

Each feature then needs its provider key: [Soniox](https://soniox.com) for
recording and dictation, [xAI](https://x.ai) for Grok Live voice mode; either
works without the other. Set a key in `SONIOX_API_KEY` or `XAI_API_KEY`, or
save it in the app when voice asks for it. A saved key applies at once,
without a restart; an environment key wins over a saved one and cannot be
replaced from the app. Node Services starts the matching voice workers
within seconds of a save and stops them when a key goes away.

Saved keys are shared by everyone on the server, and any signed-in person can
save or replace one. Live transcription and archive recovery send the audio to
the Soniox account whose key is in effect, so on a server several people
share, set `SONIOX_API_KEY` and `XAI_API_KEY` in the environment: that locks
the keys against replacement from the app.

- The Linger app always runs the LiveKit server and ffmpeg it bundles; save
  the keys in the app. Keys written by hand into `user.env` in the instance
  folder (`~/.simplexai/instances/desktop/`) act as environment keys: they win
  over the app, and changing or removing one means editing that file and
  reopening the app. A computer the app has no bundled voice tools for keeps
  voice off.
- Docker Compose from this checkout always runs LiveKit; save the keys in the
  app, or set them in `.env` and run `docker compose up --detach --wait` again.
- `pnpm dev` always starts a LiveKit server on this computer, with the ports
  and keys `.env` names. Install it first (`brew install livekit` on macOS,
  `curl -sSL https://get.livekit.io | bash` on Linux); recording also needs
  `ffmpeg` and `ffprobe` on `PATH`. Without `livekit-server` on `PATH`,
  `pnpm dev` says so and voice cannot connect.

A Native installation's LiveKit signalling listens on `127.0.0.1` only (one TCP
port for HTTP/WebSocket), with media on one UDP port (`127.0.0.1` only on macOS
and Linux; local interfaces alongside `127.0.0.1` with ICE-Lite on Windows,
where the network stack blocks cross-scope UDP between WebRTC's non-loopback
sockets and `127.0.0.1`, keeping external IP discovery and public STUN off).
Because signalling stays loopback-only, ICE credentials never leave the
computer, and no media leaves the computer except to the speech services
(Soniox, xAI) and the voice model Node Services downloads when its voice role
starts. On Windows, binding non-loopback UDP interfaces can trigger a first-run
Windows Defender Firewall prompt, and switching networks or coming online after
an offline start requires restarting LiveKit because its single-port UDP mux
snapshots local interfaces at startup.

Browsers allow the microphone only on `localhost` or HTTPS, so voice from
another computer needs an HTTPS proxy in front of port 3000.

## When a recording ends

As soon as a recording stops, Another Me posts the recording and its
transcript in its chat. A meeting summary follows under them a few seconds
later: a title and a few topics with short bullets, written from the transcript
by your Another Me's model. Grok Live reads the summaries of the recordings
among the chat's recent messages, so it can answer about a meeting that just
ended without opening its transcript. The full meeting notes (summary,
decisions, action items) take a few minutes more and appear in Library ›
Meetings; the card says so and links to them once they are written. If the
summary cannot be written, the recording and transcript stay as they are.
