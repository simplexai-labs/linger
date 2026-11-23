# Voice Runtime: LiveKit audio subscription and normalized ASR observations

## Boundary

- This directory is the worker package used by the node-services voice supervisor; it has no standalone deployment image.
- It subscribes to LiveKit microphone tracks, runs the configured streaming ASR adapter, and reports normalized observations through the generated TeamHub Voice Runtime client.
- ASR serves `hardware_control` and `chat_dictation` and publishes no audio or data tracks. The dedicated `--live` worker serves `chat_live` and publishes its reply audio and structured events.
- The supervisor starts isolated LiveKit workers: `start` (`linger-voice-runtime`) transcribes; `start --recorder` (`linger-voice-recorder`) records Capture media. While the Room metadata names an epoch, the recorder encodes the publisher track into AAC HLS segments with ffmpeg and uploads them and its state to TeamHub. It holds no object-store credentials.
- It owns no product database, Room permission, Capture classification, command execution, Artifact, Document, or Message state.
- Do not import source from another `apps/*` directory. Cross-process calls use generated contracts.

## Structure

- `src/config.ts`: validated environment configuration without logging secrets, including `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` with defaults for the LiveKit service of the root `docker-compose.yml` on its published port (TeamHub uses the same defaults), health port, session limit, Soniox model and language hints.
- `src/livekit-worker.ts`: Room/track lifecycle and bounded audio consumption.
- `src/provider-proxy.ts`: the HTTP CONNECT proxy (`HTTPS_PROXY`/`NO_PROXY`, read by `config.ts`) that only the Soniox and xAI websockets tunnel through, with Node's built-in proxy agent on `wss:` URLs. Without `HTTPS_PROXY` they connect directly as before.
- `src/asr.ts`: small provider interface and shared event helpers; `src/soniox.ts` is the only streaming adapter; the ASR worker requires `SONIOX_API_KEY`. The Live worker requires only `XAI_API_KEY` and shows the live model's own input transcript; it never uses Soniox. Recording always diarizes speakers; dictation does not. TeamHub reads the same key for archive recovery.
- `src/dictation-asr.ts`: `chat_dictation` turn segmentation over one Soniox connection; turns end on Soniox utterance endpoints or on a manual commit's non-closing finalization.
- `src/main.ts`: process lifecycle, health/readiness endpoints, and graceful shutdown.
- `src/recorder-agent.ts`: the recorder worker's job entry; follows the publisher track and Room metadata.
- `src/capture-recorder.ts`: Capture recording. Follows the Room metadata directive, reads the track at 48 kHz independently of ASR, pads silence to wall-clock time, uploads contiguous segments then the playlist, and reports active, available, or failed (including `recorder_handover` on shutdown).
- Tests stay beside the owning module as `*.test.ts`.

## Commands

- `pnpm --filter @linger/voice-runtime typecheck`
- `pnpm --filter @linger/voice-runtime test`
- `pnpm --filter @linger/voice-runtime build`

## Invariants

- Never log audio bytes, transcript text, LiveKit tokens, TeamHub tokens, or provider credentials.
- A fatal `chat_dictation` failure sets three Agent participant attributes for the Web client: `linger.voice_dictation_failure` (always `transcript_unconfirmed`; older clients read only this flag), `linger.voice_dictation_failure_code` (the logged failure code), and `linger.voice_dictation_failure_generation`. Soniox's `error_code` 401, 402 and 403 become `asr_auth_rejected`, `asr_balance_exhausted` and `asr_permission_denied`; a connection that never reaches the provider is `network_dns`, `network_refused`, `network_tls`, `network_reset`, `network_pipe` or `network_timeout`, and a proxy that refuses the tunnel is `network_proxy`. The Soniox key goes with the connection (`Authorization`), never in the start request, so Soniox may refuse it on the handshake with 401, 402 or 403, which map to the same three codes. The Web client words the codes it knows and shows its generic message for any other, so adding a code needs no client release.
- Partial observations are transient; TeamHub decides which final observations become product truth.
- A duplicated provider event reuses the same stable `event_id`.
- Every track consumer attempt claims its transcript media epoch from TeamHub (`claimVoiceMediaEpoch`) and never counts epochs in memory: a job restarted mid-session (deploy, crash, key change) must not reuse an epoch whose coverage stream an earlier job started.
- Backpressure is bounded. Failure must stop or reconnect the affected track instead of accumulating unbounded PCM.
- Shutdown waits for accepted final/progress callbacks up to a fixed deadline and then exits non-zero if state is uncertain.
- During reply playback, the Live worker's local gate sends the microphone as silence unless Silero hears speech within `otherSpeakerDb` of the level it learned on this track; quieter speech neither reaches the provider nor pauses a reply. Outside playback, Silero alone gates the microphone so a stale learned level cannot mute the user's next turn.
- Never move recording back into the ASR job process; ASR load or failure must never stall the Capture recorder. A recorder never extends an epoch it did not start; TeamHub rejects the conflicting segment and the recorder reports failure.
