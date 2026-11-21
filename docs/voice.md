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

### Transcribing on this computer

Dictation can run without a Soniox account. Set `VOICE_LOCAL_ASR=on` and point
`VOICE_LOCAL_ASR_MODEL_DIR` at an extracted
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) streaming zipformer
directory; the bilingual model below is Apache-2.0 and runs on the CPU at about
25 times realtime on two threads.

```bash
mkdir -p "$HOME/.local/share/linger/models"
curl -L -o /tmp/zipformer.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2
tar xjf /tmp/zipformer.tar.bz2 -C "$HOME/.local/share/linger/models"
export VOICE_LOCAL_ASR=on
export VOICE_LOCAL_ASR_MODEL_DIR="$HOME/.local/share/linger/models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
```

A Soniox key, when present, keeps transcription on Soniox; the local engine
serves dictation only. Recording still needs Soniox because only it labels
speakers, and a local transcript has no punctuation or casing.

`sherpa-onnx-node` is an optional dependency of `@linger/voice-runtime`. The
published build targets a newer C++ runtime than Ubuntu 22.04 provides, so the
dependency is pinned to 1.12.14; a platform without a loadable build keeps
dictation on Soniox.

A Native installation's LiveKit and ffmpeg listen on `127.0.0.1` only (one TCP
port for signalling, one UDP port for media), so no media leaves the computer
except to the speech services (Soniox, xAI) and the voice model Node Services
downloads when its voice role starts.

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
