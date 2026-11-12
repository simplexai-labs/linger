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

A Native installation's LiveKit and ffmpeg listen on `127.0.0.1` only (one TCP
port for signalling, one UDP port for media), so no media leaves the computer
except to the speech services (Soniox, xAI) and the voice model Node Services
downloads when its voice role starts.

Browsers allow the microphone only on `localhost` or HTTPS, so voice from
another computer needs an HTTPS proxy in front of port 3000.
