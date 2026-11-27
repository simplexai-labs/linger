# Linger for phones

The iOS and Android app for one Linger computer. It pairs with the computer
by scanning a code, then talks to TeamHub on that computer over an
end-to-end encrypted session: directly on the same Wi-Fi, or through a Relay
when the phone is away. `docs/mobile.md` describes the protocol.

The app uses native modules (camera, keychain, notifications, audio,
Markdown), so it runs in a development build of its own, not in Expo Go.

## Run a development build on your machine

Requirements: Xcode for iOS, Android Studio with an SDK and an emulator or a
USB-connected phone for Android, and the repository's Node dependencies
(`pnpm install --frozen-lockfile --prefer-offline` at the root).

```sh
cd apps/mobile
npx expo run:ios       # or: npx expo run:android
```

Expo CLI generates the native projects (`ios/` and `android/`, both ignored),
builds a debug app, installs it, and starts Metro. Later sessions only need
`pnpm --filter @linger/mobile start` while the installed app stays the same.
Rebuild after changing `app.config.ts`, a native dependency, or a
build-time value below.

## Build with EAS

`eas.json` has two profiles: `preview` (internal distribution; an APK on
Android) and `production`.

```sh
cd apps/mobile
EAS_PROJECT_ID=<your project id> LINGER_PUSH_SERVICE_URL=https://<push service> \
  npx eas-cli build --profile preview --platform ios   # or android
```

For EAS builds, set the build-time values as EAS environment variables of
the project instead of on the command line.

## Build-time values

`app.config.ts` reads two environment variables when the app is built. They
are baked into the app's `extra` config; the running app reads no
environment.

| Variable                  | Becomes                      | Without it                                                |
| ------------------------- | ---------------------------- | --------------------------------------------------------- |
| `EAS_PROJECT_ID`          | `extra.eas.projectId`        | No Expo push token; Settings says push is not set up.     |
| `LINGER_PUSH_SERVICE_URL` | `extra.pushServiceUrl`       | The official Push Service, `https://relay.heylinger.com`. |
| `GOOGLE_SERVICES_JSON`    | `android.googleServicesFile` | No Android push: the Firebase config is missing.          |

The Push Service is the official one in normal builds; see
`apps/relay/README.md` for running your own.

## Pair with a local `pnpm dev` TeamHub

1. Start Linger on your computer with `pnpm dev` from the repository root.
   The local defaults set `LINGER_SECRET_SEED`, which the Mobile Gateway
   needs, and `TEAMHUB_MOBILE_LAN_ADDRESS=0.0.0.0:7787`, its local-network
   listener.
2. Put the phone on the same Wi-Fi as the computer. Allow incoming
   connections to TeamHub if the macOS firewall asks; the phone dials port
   7787 (or the free port TeamHub fell back to, which the pairing code
   carries).
3. In the Web app, open Settings, then Phones, and choose Pair a phone.
4. Open Linger on the phone and scan the code. On iOS, allow Local Network
   access when asked; without it only a Relay can reach the computer. A
   phone that cannot scan, such as the iOS Simulator, takes the computer's
   Copy pairing link instead: open the link on the phone or paste it under
   "Can't scan? Use a pairing link".
5. The phone shows a six-digit code. Check that Settings, then Phones on the
   computer shows the same code, and approve the phone there.

To reach the computer away from its Wi-Fi, run a Relay (`apps/relay`) and
set `TEAMHUB_MOBILE_RELAY_URL` to its `wss://` origin before pairing.

## Voice

Dictation (the composer's Dictate button), Live (the composer's Live button)
and meeting recording (Record meeting in the menu) need voice set up on the
computer, as for the Web app, and a development build: Expo Go has no
`react-native-audio-api`.

- The first use asks for the microphone after saying why. A refusal points to
  Settings.
- Dictation sends each finished sentence to the Room as the Web app's Voice
  Mode does. Stop sends the last words; anything not finalized goes back into
  the composer.
- Live plays Another Me's voice on the loudspeaker, or on headphones when
  connected, with echo cancellation on.
- A recording keeps going with the screen locked: iOS uses background audio,
  Android a microphone foreground service with a notification. The phone also
  keeps its own copy and sends it to the Another Me chat only when the
  computer's copy has a gap.

Check voice on a real phone: the simulator and emulator microphones skip echo
cancellation and background behaviour.

## Checks

```sh
pnpm --filter @linger/mobile check
```

runs the typecheck, lint and unit tests. `AGENTS.md` lists the structure and
the rules the code follows.
