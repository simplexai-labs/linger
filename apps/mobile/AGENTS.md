# Mobile App: the phone client of one Linger computer

React Native 0.88 with Expo SDK 58 (New Architecture, Hermes) and
expo-router. The phone reaches TeamHub on the user's own computer over one
end-to-end encrypted session, directly on the local network or through the
Relay. `docs/mobile.md` specifies the session, pairing, push, phone storage
and reading rules; `docs/adr/0001` to `0004` record why.

## Common Commands

- `pnpm --filter @linger/mobile check`: typecheck, lint and unit tests (the
  `make check-mobile` fast check).
- `pnpm --filter @linger/mobile exec vitest run <file>`: run one test.
  `src/session/session.test.ts` runs against the real Go gateway test server
  and is skipped without `go`.
- `cd apps/mobile && npx expo export --platform ios --platform android --output-dir /tmp/linger-mobile-export`:
  check that both JS bundles build; delete the output afterwards.
- `README.md` explains development builds and pairing with a local TeamHub.

## Structure

- `src/app`: expo-router routes. `(main)` is the drawer, an iOS-style
  sidebar with the Library, every chat under Messages (Another Me first) and
  Settings at the bottom; `pair`,
  `document/[documentId]`, `voice/[mode]` (Live with the chat's own Agent,
  or a recording) and `agent/[agentId]` (an Agent's read-only profile sheet:
  details, the chat's Routines and its connected accounts, no Skills) sit on
  the root stack. A chat's header opens Record; its composer opens Live when
  empty and sends when not.
- `src/session`: Noise XK handshake, frames, the session and HTTP over it.
- `src/computer`: pairing links, the pairing handshake, per-computer storage,
  and `ComputerConnection` (LAN-first race, backoff, status).
  `relay-nodes.ts` holds the Relay node list each computer names and the dial
  order: Automatic tries the fastest node it measured first, or only the node
  the Human pinned in Settings, Relay.
- `src/api`: typed TeamHub calls over the session, using the
  `@linger/wire-contracts` teamhub-public types; multipart bodies as bytes.
- `src/realtime`: the `/v0/events` stream, Room cursors and gap paging, and
  the projection of Room Events into the query cache.
- `src/chat`: timeline, composer, outbox, run status with Stop, decision
  cards.
- `src/library`: the Library's three tabs (Meetings, Documents, Wiki, with
  Wiki pages chosen as the web's Wiki tree does), meeting recordings, and
  read-only Markdown, text, images and audio. Generated knowledge pages hide
  their leading metadata block (`knowledge-markdown.ts`).
- `src/push`: push grants and notification routing.
- `src/voice`: dictation, Live and meeting recording over the Voice Bridge
  (`docs/mobile.md`, "Voice"). `bridge-client.ts` is the `/v1/voice-bridge`
  socket protocol (sequence numbers, acks, resume, drain); `pcm.ts` frames
  audio; `live-turns.ts` ports the browser's Live turn rules;
  `voice-session.ts`, `voice-link.ts` and `voice-events.ts` open the
  VoiceSession, start the Bridge and follow the voice events stream;
  `audio.ts` is the only module that touches `react-native-audio-api`.
  Live and recording are `voice/[mode]` screens.
- `modules/file-preview`: the one local native module, handing a cached
  file to the system viewer. Changing it needs a native build.
- `src/library/file-kind.ts`: file kinds, labels and which viewer opens a
  file, following the web's `artifact-file-kind.ts`.
- `viewer/`: the offline file viewer page (pdf.js, open-file-viewer,
  papaparse, mermaid, as on the desktop). `scripts/build-viewer.mjs` bundles
  it into the ignored `assets/viewer/viewer.html`; `pnpm start`, `check` and
  EAS's `eas-build-post-install` run it. `src/library/file-viewer.tsx` shows
  it in a WebView.
- `src/i18n`: the interface language (Follow System, English, Simplified
  Chinese) kept on this phone, `useTranslation()` for screens and `t()` for
  plain modules, over `@linger/service-kit/messages` as on the Web. English
  source text lives in `*.messages.ts` files beside the code (outside
  `src/app`, whose every file is a route); translations live in
  `src/i18n/locales/zh-CN.json` and follow the Web's glossary
  (`apps/web/src/i18n/locales/zh-CN.glossary.md`).
  `src/i18n/catalog.test.ts` checks every message is translated with the
  same placeholders.
- `src/theme.ts`: the Linger design system's tokens from the web
  (`apps/web/src/app/visual-theme.css`, `globals.css`): colors, the radius
  steps 4/6/8/12/16/pill, the chat text sizes 15/22 and 13/18, and shadows
  for floating layers only. Screens use these tokens, not literal values.
- `src/ui`: shared controls, the design system's dialog
  (`confirm-dialog.tsx`, never the system alert for a question), settings
  groups and rows (`settings.tsx`, iOS inset grouped), the Reduce Motion
  hook (`motion.ts`, which every loop and swell follows), press feedback
  (`press-scale.tsx`: buttons and cards sink to 97% in 120 ms on the UI
  thread; list rows highlight instead), haptics for a few commits
  (`haptics.ts`), avatars and icons. React Native has no SVG renderer here, so
  `scripts/export-agent-avatars.mjs` renders the web's Agent figures
  (`apps/web/public/agent-avatars`) and `scripts/export-icons.mjs` the web's Hugeicons (the
  same icon for the same job, stroke 2 up to 16px and 1.5 from 20px)
  into PNGs under `assets/`, with generated `*.generated.ts` tables.
  `scripts/export-app-icons.mjs` derives the launcher icons and splash from
  the approved tile in `apps/assets/logo/source/linger.svg`. Rerun them (they
  need Google Chrome) when the figures, icons or logo change.

## Invariants

- Everything the phone keeps belongs to one paired computer: files under
  `<documents>/computers/<hostId>/` and one keychain entry
  (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`). Unpairing, or learning that the
  computer removed the phone, deletes all of it. Document bodies are not
  kept, and audio from the computer lives in the cache only while its screen
  is open. The phone's own meeting recording lives under
  `computers/<hostId>/recordings/` until the computer has the meeting (its
  Capture finalized without gaps, or the files were uploaded to the Another
  Me chat); `voice-session.json` names the VoiceSession the phone has open,
  so one left by a crash is closed before the next.
- Every TeamHub route the app calls must be on the Mobile API allowlist
  (`apps/teamhub/internal/mobilegateway/allowlist.go`). Add a route there in
  the same change, and only a `teamhub-public` operation the phone needs.
- The phone never accepts a different computer key: a handshake that fails
  against the pinned key asks the Human to pair again.
- Writes carry an `Idempotency-Key`. The outbox stores each message's Room,
  key and exact body before sending and resends that identical request until
  the computer answers.
- Never log keys, invites, messages, document text or audio. The only log is
  `src/lib/app-log.ts`: JSON lines of event names, codes, counts and timings
  in `<documents>/logs/` (two files of 256 KB). Settings › Send Diagnostics
  zips it to the desktop's receiver (`src/lib/diagnostics-upload.ts`,
  docs/diagnostics-upload.md) when the build names one in
  `LINGER_DIAGNOSTICS_UPLOAD_URL`, and Save Diagnostics hands it to the
  share sheet; logic modules write through
  `logEvent`, and `no-console` is an error. `src/lib/timing.ts` counts where
  the phone spends its time and the log records a summary each minute.
- The only web view is the offline file viewer. It loads the bundled page
  from beside the downloaded file, may read only that directory, and never
  reaches the network. Text, Markdown, code, small images and audio render
  natively; files the viewer cannot show are handed to the system viewer
  (`modules/file-preview`: Quick Look on iOS, the app the system picks on
  Android). The cache file is deleted when its screen closes.
- English source text, like the rest of the repository; other languages go
  only in `src/i18n/locales/`. Call `t()` when text is shown, never at
  module scope, because the language can change while the app runs.
- Logic lives in modules that import no Expo or React Native code, so Vitest
  runs them in Node; the device adapters (`store-expo.ts`, `push.ts`,
  `voice/audio.ts`, screens) stay thin.
- Voice follows the browser: a dictation turn becomes the Human's Message
  keyed `voice-mode:<turn>`, a Live turn is saved once with its
  `voice_live_turn` marker, and both go through the outbox. Audio waits on the
  phone until the Runtime reports input ready, and ending a dictation turn or
  a recording waits for the Bridge to acknowledge the last frame.
- Messages are built as the browser builds them (`src/chat/compose-message.ts`):
  an @ the Human picked becomes a reference segment, and in a direct Agent
  chat every message leads with that Agent's @ so it wakes; the screen hides
  that leading @.
- One voice feature holds the microphone at a time; a voice screen ends only
  through its own End or Stop (swipe-to-dismiss is off), which closes the
  VoiceSession.
