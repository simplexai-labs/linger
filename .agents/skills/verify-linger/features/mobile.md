# Mobile App and paired computers

Verify that a Human can pair a phone, use the intended computer, and recover work after a connection drops. Confirm each write from a fresh computer-side read.

Record the installed phone, Desktop, TeamHub, Relay, and Voice Runtime versions before using these recipes. See the [shared verification rules](README.md), [parent skill](../SKILL.md), and [Mobile App design](../../../../docs/mobile.md).

## Test environment and evidence

| Environment                                                  | What it can establish                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS Simulator with `axe` and a native Expo development build | Pairing links, approval, navigation, real TeamHub reads and writes, reconnects, decision controls, file previews, and diagnostics. Use the native build from `apps/mobile`, such as `npx expo run:ios`.                              |
| Physical phone                                               | Optical QR scanning, cellular fallback, iOS Local Network permission, microphone capture, speaker playback, interruptions, screen lock, and actual push delivery. Use Android hardware for Android notification and viewer behavior. |
| Second phone identity                                        | Spent invites, independent approvals, and removal isolation. A second Simulator can supply an independent identity. Use two registered physical devices to compare actual push delivery.                                             |
| Second computer                                              | Switching computers and isolating messages, recordings, Relay preferences, and push targets. Use two TeamHub instances with different private seeds, host IDs, and recognizable Rooms.                                               |
| Real product Agent and model                                 | A live Run, cancellation, a subsequent reply, or an approved action's business effect. Use an enrolled Computer, a working Daemon, and an authenticated Runtime.                                                                     |
| Real voice services                                          | Meeting capture needs LiveKit, the phone bridge, recorder, and configured speech recognition. Spoken Live replies need the Live worker and configured xAI service. Desktop media also needs a real desktop microphone.               |

Use an owned, disposable environment with a signed-in Human, PostgreSQL, TeamHub, and Web Settings > Phones. Provision Another Me, a second direct Agent chat, and a group Room. The parent skill's default Document proof starts only part of this environment. Add the dependencies required by each selected journey.

Drive the Simulator by accessibility label. Read the current tree after navigation. The following example uses an approved phone and an open test Room.

```sh
axe list-simulators
axe describe-ui --udid "$udid"
axe tap --label 'Open the menu' --udid "$udid"
axe tap --label 'Linger, your Another Me' --udid "$udid"
axe tap --label 'Message' --udid "$udid"
axe type 'mobile-check-01' --udid "$udid"
axe tap --label 'Send' --udid "$udid"
axe screenshot --udid "$udid" --output "$evidence/chat.png"
```

Use the provisioned Agent's display name when Another Me has been renamed. Inspect avatars, clipping, previews, and status placement in screenshots at the displayed size. An accessibility tree cannot show how a group avatar looks.

For each branch, record the device, route, action, visible result, and independent evidence. Mark unexecuted branches as skipped or blocked and name the missing dependency. Keep invites, QR images, confirmation digits, keys, push tokens, grants, signed URLs, and private conversation content out of retained evidence.

Mobile test paths below start at `apps/mobile/src/`. TeamHub integration test filenames refer to `apps/teamhub/tests/integration/`. `make check-mobile` and `make check-relay` are the owning fast checks. Reuse focused results from the tested revision.

## Pair a phone

Use a fresh phone identity and Web Settings > Phones at `/t/{tenantId}/settings/phones`. A Simulator covers the link and approval. A physical phone covers the camera.

1. Choose `Pair a phone` on the computer. Scan the displayed QR using `Allow camera` on the phone. In another run, deny camera access and choose `Can't scan? Use a pairing link`.
2. Choose `Copy pairing link` on the computer. Paste privately into `Pairing link`, then tap `Pair`. Also open a fresh `linger://pair?d=...` link through the operating system. The Simulator can receive private clipboard input through `axe type --stdin`.
3. Compare the six digits on both devices. The phone displays two groups of three. The computer asks `Is this your phone?`. Leave approval pending and confirm that Room data remains inaccessible.
4. Disconnect and reconnect while pending. The same phone row and confirmation digits should return. Cover a lost initial welcome using the pairing test. A retry over another route must produce only one pending phone.
5. Choose `Approve` on the computer. The phone enters Linger after any notification prompt. Refresh Phones and check the platform, connection status, and push status. Repeat pairing over Relay with LAN unavailable.
6. On a separate invite, choose `Not my phone`. The waiting phone explains that the computer did not approve it and offers `Scan again`. Also let a pending approval expire.
7. Try an empty input, malformed link, newer link format, expired invite, and spent invite. Empty input disables `Pair`. An expired invite can be replaced with `New code`. Use a different phone identity for the spent invite.
8. Try a computer with only LAN, then one with no usable route or an unavailable Mobile Gateway. Check the computer's explanation. Restore a route and complete pairing with a valid invite.

Keep the phone row ID, platform, timestamps, pending denial, and approved Room read. Record only whether the codes matched. Both the invite and pending approval have ten-minute lifetimes.

Reuse `computer/pairing-link.test.ts`, `computer/pairing.test.ts`, `session/session.test.ts`, the Go `internal/mobilegateway` tests, and Web `phones-settings-page.test.tsx`. The mobile session test uses a Go gateway with stand-in business handlers and can skip when Go is unavailable.

## Select a connection route

Use one approved phone, reachable LAN, and two linked Relay nodes. The Simulator can use independently controlled test routes. Use a physical phone for cellular and iOS Local Network denial. Relay testing needs a private computer seed. The public development seed or an explicitly empty `TEAMHUB_MOBILE_RELAY_URL` gives a LAN-only environment.

1. With LAN healthy, open Settings. Check `Connected` and `Same Wi-Fi`. Send a marker and read it on the computer.
2. Make LAN unreachable and reconnect. Settings names the winning Relay, its row says `In use`, and the sidebar says `Through a Relay`. Send another marker. On iOS hardware, repeat with Local Network denied and with cellular.
3. Choose `Automatic Relay node`. Reopen Settings and inspect the round-trip times. Each measured value is the rounded median of three `GET /v0/session` requests over an open session. An unavailable measurement can end in a dash.
4. Give the nodes distinguishable latencies. On a fresh connection, Automatic tries the fastest remembered node first. Make it unavailable and verify the other node can carry a message.
5. Choose `Use only <label>`. With LAN unavailable, reconnect and reopen Settings. Only the pinned Relay should receive new connection attempts and latency probes. Let earlier probes finish before checking node logs.
6. Stop the pinned Relay while the other stays healthy. The phone retries offline. Restore the pin, choose Automatic, or restore LAN and confirm recovery. LAN remains eligible with a pin.
7. Restore LAN during a healthy Relay session. Trigger a new connection before judging LAN preference. Disable or remove the pin on the computer, refresh the enabled list over a working route, and verify Automatic becomes selected.

Keep the selected row, `In use` row, displayed times, fresh Room reads, and timestamped Relay activity. A latency probe also opens a short Relay session. Correlate the winning route with the business request.

Reuse `computer/connection.test.ts`, `computer/relay-nodes.test.ts`, TeamHub `internal/mobilerelay/mobilerelay_test.go`, and `apps/relay/internal/relay/relay_test.go`. The connection test covers the 300 ms LAN head start and the 250 ms Automatic Relay head start.

## Manage Relay nodes

Use the Simulator, Web Settings > Phones, and an owned Relay with a publicly resolving address. Start with at least one enabled node so the phone shows its Relay settings.

1. On the computer, inspect `Relay nodes`. Check `Linger Global`, `Linger Mainland China`, the `Official` or `Custom` designation, and `Linked`, `Linking`, or `Off`.
2. On the phone, tap `Add Node`. Enter a bare `ws://` or `wss://` origin in `Relay node address`. Test `Cancel` first. Then choose `Add`, refresh Web, and carry a message through the new node.
3. Try blank input, an unsupported scheme, and an address with a path, query, fragment, or embedded credentials. Blank input disables `Add`. Invalid origins produce address guidance and `INVALID_RELAY_URL`.
4. Add an equivalent existing origin, including a trailing-slash variant. Expect `RELAY_EXISTS`. Try a private or loopback address from the phone. Expect `RELAY_PRIVATE_FROM_PHONE` and guidance to add it on the computer.
5. On the computer, add an owned private-network node. Disable and re-enable it. Remove a custom node. Official nodes offer disabling only. The phone offers listing and adding.
6. With eight custom nodes stored, try a ninth. Expect `TOO_MANY_RELAYS`. Disabled custom nodes count toward eight. Remove one on the computer and retry.
7. Disconnect the phone and inspect `Add`. Restore the session before submitting. Then disable every node on the computer. After refresh, the phone hides the Relay group. Re-enable one from Web and reconnect without pairing again.

Keep before/after node counts, kinds, enabled states, error codes, and one message delivered through the added node. For compatibility, reuse checks for the first four enabled nodes in an invite, the full welcome list, legacy `relay`, and explicitly empty `relays`.

Reuse `computer/relay-nodes.test.ts`, `computer/pairing-link.test.ts`, Web `phones-settings-page.test.tsx`, TeamHub `internal/mobilerelay/mobilerelay_test.go`, and `internal/app/mobile_allowlist_test.go`.

## Switch or unpair a computer

Use one Simulator and two independently paired computers, A and B. Give each a distinct Room marker and Relay preference. This journey needs no model.

1. Pair A. From Settings choose `Pair Another Computer` and pair B. Tap `Switch to <name>` for A. Home, Settings, and the sidebar must identify A. Repeat for B and relaunch.
2. Open A's Room, disconnect A, and queue a message. Switch to B while B is reachable. Check B's Room and outbox. Switch back to A and restore its route. Only A should receive the queued message, once.
3. On disposable A, prepare a queued message, a Relay preference, and any recording or push state selected for verification. Choose `Unpair <name>`, then `Cancel`. A remains usable.
4. Repeat and confirm `Unpair`. If B remains, verify B becomes active. Unpair the last computer separately and check `Pair with your computer`.
5. Check that A's phone key and `computers/<hostId>/` directory are gone. This includes pairing metadata, Relay settings, outbox, push record, remembered voice session, and pending recording files. Check that A's cached reads and Room positions cannot appear under B.
6. Refresh Phones on A. Phone-side unpairing forgets A locally. Its computer-side registration can remain until removed there. Verify B still opens its own Rooms and retains its settings.

Keep host and Room IDs, before/after file counts, key-entry presence, and fresh reads from both computers. Inspect key presence without reading its value. App-wide diagnostic logs have a separate lifecycle. Downloaded previews are covered under Library.

Reuse `computer/connection.test.ts`, `chat/outbox.test.ts`, and `push/grant.test.ts`. The two-computer UI journey and per-host deletion need direct observation.

## Navigate Messages and chats

Use the Simulator with Another Me, another direct chat, and groups with known members. Prepare different last messages, unread counts, and Agent avatars.

1. Tap `Open the menu`. `Messages` is the heading. The first card is `<name>, your Another Me`, followed by one `Library` row with `Meetings, documents and wiki`. Other chats follow in TeamHub order.
2. Open another chat and reopen the menu. Check the selected chat and the inactive Linger card. Return through the card and check its active color and avatar. Scroll a long list and open the fixed `Settings` footer. Check the computer name, connection state, and Settings `Version`.
3. Check a chat's name, last-message preview, time, and unread badge. Send from the current Human and check the `You:` preview. Exercise an ordinary chat with more than 99 unread messages. Its badge shows `99+`.
4. Open an unread Room and leave it active in the foreground. Verify its read position advances from a fresh read. Background the phone or select another Room and verify the other Room's messages do not mark themselves read.
5. Open the separate Messages grid through `/rooms`, using `linger://rooms` on the Simulator. Check the full-width Another Me card, two-column chat cards, and navigation to the correct Room.
6. Compare group avatars in the sidebar, grid, and group header. Zero supplied faces show the generic Room icon. One shows a single face, two a diagonal pair, three a lead face above two, and four a four-tile group.
7. With five supplied members, expect the first three faces plus `+2`. For a larger Room, compare each surface with its own member data. The sidebar uses the bounded member preview. The group header uses the fetched member list and displays its count.
8. Check Agent images, fallback figures, Human initials, and a direct chat's large Agent face. Open the keyboard and dismiss it. The direct stage folds and restores. Load older history and check authors, group names, Markdown, and file cards across the page boundary.
9. Exercise an unprovisioned Another Me, a failed home fetch, a cold offline start, and an inaccessible Room link. Check `Linger is getting ready`, `Try again`, or `Waiting for your computer` as applicable. Reconnect and open an authorized Room.

Keep actual-size screenshots of the drawer, grid, group avatar variants, and folded stage. Retain Room IDs, supplied member order, and before/after read positions. No model is needed for prepared history.

Reuse `ui/avatar-key.test.ts`, `chat/bubble-segments.test.ts`, `realtime/room-events.test.ts`, Web `room-avatar.test.tsx`, and `room-startup.spec.ts`. Inspect the native layout separately.

## Send text and attachments

Use the Simulator with a writable direct chat, a group Room, and disposable files in the native picker. Use another signed-in view to read the resulting messages.

1. Tap `Message`. Empty or whitespace-only input cannot send a blank message. Enter a unique marker and tap `Send`. Check the author, Room, body, and single delivered bubble.
2. Type `@` at the caret in a group. Choose `Mention <name>`. Check the stored actor reference. Compare with an unselected literal name and a selected mention removed before sending. Suggestions exclude self, the direct peer, and already selected mentions.
3. In a direct chat, send ordinary text. Verify the intended Agent receives the addressed message and the phone displays the Human's words without the generated recipient prefix. A real model is needed only to claim an Agent reply.
4. Tap `Attach` and choose `Camera`, `Photos` or `Files`. Cancel once, then select a file from each. Upload starts immediately. The chip shows progress, and sending waits for completion. Remove an uploaded chip before sending. Verify it produces no message attachment.
5. Send a file-only message and a text-plus-file message. Open each delivered card. Compare filename, size, contents, and Document Version with the computer. Check supported images inline through 8 MiB. A larger image opens from its file card.
6. Try a known-size file exactly at 25 MiB and one byte above. The first reaches server validation. The second is rejected on the phone. Exercise a stricter server limit for the distinct `413` explanation.
7. Try attaching while offline, interrupt an upload, and reselect after recovery. A new attachment requires connectivity. An already uploaded attachment can travel in a queued message.

Keep message and version IDs, mention target, source and downloaded file sizes or digests, and native picker or chip evidence. A successful upload alone proves only staging.

Reuse `chat/compose-message.test.ts`, `chat/bubble-segments.test.ts`, `api/multipart.test.ts`, TeamHub `message_attachment_test.go`, and `mention_test.go`.

## Deliver the offline outbox

Use the Simulator, an approved computer, and an already opened writable Room. Arrange controlled connectivity and a test response that can be withheld after TeamHub saves a message.

1. Disconnect every route. Send two distinct messages in order. Include an already uploaded attachment in one. Both appear as `Sending…`. Check that the computer has received neither.
2. Relaunch the phone while offline, restore connectivity, and reopen the Room. The phone resends the original destination, body, attachment IDs, and idempotency key for each entry.
3. In a separate run, let TeamHub save the first message and withhold its acknowledgement. Reconnect. A fresh Room read must show exactly one message per key, in order. The pending bubbles should reconcile with the delivered messages.
4. Exercise a temporary refusal such as `429` or a server error. Later queued entries wait behind the retry. For a permanent refusal, check `Not sent`, `Send again`, and `Delete this message`. Later valid entries can proceed.
5. Restore the condition behind a recoverable refusal and tap `Send again`. Discard a separate failed entry. Reopen the Room and compare both outcomes. Repeat the host-switch branch under [Switch or unpair a computer](#switch-or-unpair-a-computer).

Keep per-key message counts, ordered message IDs, authors, Room IDs, and the final outbox count. Use a fresh TeamHub or Web read after acknowledgement loss. A bubble disappearing is insufficient evidence of delivery.

Reuse `chat/outbox.test.ts`, `chat/compose-message.test.ts`, and `realtime/room-events.test.ts`. This journey needs no model.

## Follow and stop a Run

Use the Simulator with a real working Agent. Prepare a direct chat and a group where two Agents can work concurrently. Choose work long enough to observe and cancel.

1. Send a request. Observe queued or thinking status, the Agent's current activity, and available plan detail. In the direct chat, the working line and `Stop <Agent>` occupy one stage slot. Check the folded stage with the keyboard open.
2. Compare an idle face with a working face. Repeat with Reduce Motion enabled. In a group, verify each active Agent has its own status above the composer.
3. Start two group Runs. Tap `Stop <Agent>` for one. Observe `Stopping…` while cancellation is pending. Read both Run IDs on the computer. The selected Run must reach its terminal state and the other must continue.
4. Let a Run reply or finish before a late Stop. Reconcile to its actual terminal state. Exercise a disconnected or refused Stop. Reconnect and read the Run before attributing cancellation to the phone.
5. Start a fresh request and receive its reply. Verify the completed Run's Stop control disappears.

Keep the two Run IDs, selected Agent, cancellation response, terminal states, and fresh reply ID. Simulator controls and generated status events cover rendering. Actual cancellation and resumed work require the Daemon, Runtime, and model.

Reuse `chat/run-status.test.ts`, `room_run_control_test.go`, `run_status_events_test.go`, and [Stop by Run ID](rooms.md#run-status-and-stop-by-run-id).

## Answer a decision

Use a Simulator paired as the decision owner. Prepare decisions with known contents and another authorized Web session or phone for stale-version checks. Use a different Human for the non-owner case.

| Phone-answerable kind | What to inspect and do                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question`            | Answer every required prompt. Exercise radio, checkbox, and custom text. A single-choice custom answer replaces its selected option. Check `Send answer` before and after completion. |
| `runtime_permission`  | Inspect the rationale, target page, annotated screenshot, command, script, patch, and tool when supplied. Expand a detail longer than 400 characters with `Show all`.                 |
| `connector_write`     | Inspect the app, account, recipients, subject, body, fields, and full request supplied by the card. Check the authorized destination before approving.                                |
| `agent_change`        | Inspect the proposed change, including before and after values. Compare the resulting Agent state after approval.                                                                     |

1. Submit a question. Use separate pending cards to `Approve` and `Deny` each applicable approval kind. Refresh the original Room message and check its version, outcome, and resulting action.
2. Open pending `profile_setup_apps`, `profile_setup_sources`, `connection_auth`, `provider_key`, `browser_connection`, `room_creation`, `computer_permission`, and `search_key` cards. The owner sees `Open on your computer to answer this.` Verify the gateway's `403 DECIDE_ON_COMPUTER` boundary through its existing check.
3. View another Human's pending card. It identifies the decision owner and offers no answer control. Reopen answered, denied, and expired examples and check their terminal summaries.
4. Keep a card displayed on the phone while another session answers it. Exercise submission of the stale version. A `409` produces `This card changed. Check it again.` and refetches the original message. Verify one business effect.
5. Disconnect before answering. Check `Your answer was not sent. Try again.` Reconnect, read the current card, and answer only while still pending. Decisions do not enter the chat outbox.

Keep decision kind, owner, version before and after, saved answer or refusal, and an independent read of the effect. Prepared cards cover UI branches. A real model or authorized supplier is required to claim actual execution or delivery.

Reuse `internal/typedcard/decisions_test.go`, `internal/app/mobile_allowlist_test.go`, `runtime_permission_review_test.go`, `connector_confirmation_test.go`, and Web `decision-card.test.tsx` and `decision-question-view.test.tsx`.

## Inspect an Agent

Use the Simulator with an Agent that has long instructions, Room routines, and at least one granted connector account. Prepare another Room and an ungranted account for comparison. No inference is required.

1. Tap `About <Agent>` on the expanded direct stage. In a group, tap an Agent author's avatar. A Human author should not open an Agent sheet.
2. Open `Details`. Compare description, instructions, model, and availability with the selected Agent. Use `Show more` and `Show less` on long instructions.
3. Open `Routines`. Check cadence and `Off` for a disabled routine. Only this Room's unassigned routines or routines assigned to this Agent belong here. Test `No Routines in this chat` and an entry without Room context.
4. Open `Connectors`. Compare the displayed provider and account identity with active, explicitly granted accounts. Exercise `No connected accounts`. Inspect all three tabs for read-only behavior.
5. Open an unavailable Agent, interrupt a fetch, and reopen after reconnecting. Verify the online result before accepting an empty tab as evidence of no grants or routines. Close the sheet and confirm the original Room.

Keep Agent and Room IDs, the matching routine and grant inventory, and one screenshot per populated tab. Reuse `chat/routine-cadence.test.ts`, `ui/avatar-key.test.ts`, and Web `agent-info-content.test.tsx`. The mobile sheet itself needs a Simulator walkthrough.

## Read the Library

Use the Simulator with authorized Documents, generated Wiki pages, and personal meetings. Include two versions of one file, a read-only Wiki page, and an inaccessible object. Seeded content is sufficient for reading.

1. Open the drawer's `Library` row. `Meetings` opens first and groups entries by day. Check recent `Documents` and `Wiki`. Exercise pull-to-refresh, pagination, genuinely empty lists, `This list did not load`, and `Try again`.
2. Disconnect and open the Library. Check `Waiting for your computer`. Reconnect and verify the intended computer's lists return.
3. Open a file from a chat, then open its newer version from Documents. The chat attachment opens its referenced version. The Library opens the current version. Compare recognizable contents in both.
4. Open a read-only Wiki file through its Document Version. Open a native Document through the latest-download route using an identity with export access. Exercise export denial and a delayed `202` response. The client honors `Retry-After` within its bounded retry loop.
5. Test the preview boundaries below with valid files. Use an exact-size file and one byte above each applicable threshold. One MiB is 1,048,576 bytes.

| Surface                                                                       | Expected result                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown, text, and code                                                      | The in-app reader handles up to 2 MiB. Oversized content offers `Open on your computer`.                                                          |
| PNG, JPEG, GIF, and WebP                                                      | The in-app image viewer handles up to 20 MiB. Check double-tap zoom, pinch, pan, and return to fit.                                               |
| Chat image                                                                    | The inline limit is 8 MiB. A larger supported image can still open in the Document viewer within its 20 MiB limit.                                |
| Audio                                                                         | Download to a temporary file, play, pause, scrub, and seek with the screen still open after disconnecting.                                        |
| PDF, Office, CSV and TSV, HTML, Mermaid, other images, and video up to 50 MiB | The in-app viewer shows the file. A table over 5,000 rows or 5 MiB shows its head with a note. The header's share button opens the system viewer. |
| Larger files, archives, and files the viewer cannot read                      | Open the downloaded file in iOS Quick Look or the Android viewer. Check progress, reopen, and an unavailable viewer or interrupted download.      |

6. In Wiki, inspect Projects, Topics, People, Companies, Conversations, and remaining Pages when populated. Check a dated meeting note. Generated pages should show readable titles and prose. Source documents and `index.md` stay out of the list. Check that metadata and generated citation markup are hidden while fenced code survives.
7. Open a meeting. Compare `Summary` and `Transcript`, speakers, timestamps, and the recording with the same meeting on the computer. While a summary is pending, wait for its 15-second refresh. Check that the title appears once.
8. Play its recording, use `Back 15 seconds` and `Forward 15 seconds`, and scrub. Close the screen and check that its temporary file is removed. Reopen with a failed download, then retry online.
9. Open a deleted Document, a forbidden version, and another Human's private meeting. A denied content read can show `You cannot read this here`. Verify no protected content appears. Restore access on a disposable object and reopen it.

Keep object and version IDs, byte counts, screenshots, playback positions, cache presence before and after closing, and fresh permission results. Use physical hardware for platform playback claims. Generated meeting or Wiki content requires the corresponding real services when generation itself is under test.

Reuse `library/file-kind.test.ts`, `library/library-items.test.ts`, `library/knowledge-markdown.test.ts`, `library/wiki-pages.test.ts`, Web `room-document-assets.spec.ts`, and [Library and meetings](library.md).

## Record and deliver a meeting

Use Another Me's home chat, an approved physical phone, LiveKit, the bridge, recorder, and speech recognition. Prepare a short spoken sequence with distinguishable first, middle, and final words. The Simulator can exercise entry, permission controls, and failure screens.

1. From the expanded Linger chat header, tap `Record a meeting`, then `Start recording`. Try `Not now` at the microphone explanation and deny the operating-system prompt separately. Check the settings guidance and verify no recording starts.
2. Repeat with permission granted. Check the timer, microphone level, partial transcript, and finalized words. Lock and unlock the phone. Exercise an interruption and recovery. On Android, check the foreground recording notification.
3. Tap `Stop`, choose `Keep recording`, speak the final word, then confirm `Stop`. Observe the final audio drain and saving state. Read the computer's Capture status and gap count.
4. For a `finalized` Capture with zero gaps, open the meeting in Library and its notes in the Linger chat. Listen to the actual audio, including the final word. The phone can delete its local recording after this confirmation.
5. Interrupt the route briefly while speaking, then restore it. Check that the same session resumes and delivers unacknowledged audio without doubling words. Compare the audio before, during, and after the drop.
6. Exercise a recording gap, lost bridge backlog, or failed Capture with a usable phone copy. The phone sends `Full phone recording (the live copy has a gap)` to Another Me. Local M4A segments rotate at 8 MiB. Each message carries up to five attachments.
7. Interrupt the fallback upload. Check the retained files under `computers/<hostId>/recordings/`. Restore connectivity and use `Send again` while the recording screen is open. Read every resulting chat message and play its attachments in order.
8. Withhold the chat acknowledgement after upload. At the 60-second delivery wait, the screen can report that the recording is on its way. The files must still exist. In a separately acknowledged run, check deletion only after all carrying messages arrive.
9. Exercise an unavailable recorder, absent Another Me Room, and a Capture still nonterminal after the saving wait. Record the displayed outcome and file presence. The saving wait is 20 minutes. Late cleanup and resend after relaunch require separate observation.

Keep the Room, voice session, Capture, message, and attachment IDs. Record gap count, segment sizes, timing around interruption, final-word playback, and local file counts. Distinguish an uploaded attachment from a delivered chat message.

Reuse `voice/bridge-client.test.ts`, `voice/pcm.test.ts`, `apps/voice-runtime/src/bridge.test.ts`, `apps/node-services/tests/voice/bridge-proxy.test.ts`, and `voice_completion_boundary_test.go`. The long-recording worker check uses LiveKit directly. Physical capture and phone-copy delivery need the phone journey.

## Start and end Live on the phone

Use a physical phone, working bridge, LiveKit, and configured xAI Live worker for spoken results. Use the Simulator for routing, consent, and unavailable states.

1. In an empty direct-chat composer, tap `Talk live`. This deliberate tap starts Live after microphone permission. With a draft present, the composer offers `Send`. Verify the direct chat targets its Agent.
2. Repeat in a group with Another Me as an active member. Verify the target Room. Try a group without the required Agent and an inaccessible Room. Check the refusal and absence of a usable session.
3. After ending the call, open the external link. On the Simulator use `xcrun simctl openurl "$udid" 'linger://voice/live'`. Even with microphone permission granted, it must ask `Talk live with <name>?`.
4. Choose `Cancel` and check that neither microphone capture nor a voice session started. Open the link again and choose `Start`. Test a valid `roomId`, an invalid Room, and an unknown voice mode. Omitting `roomId` targets Another Me.
5. Speak a recognizable question. Check `Listening`, the Human subtitle, reply subtitle, and audible answer. Mute and unmute. Interrupt the reply by speaking again. Verify the next turn remains intelligible and the subtitles follow spoken order.
6. Drop the route briefly. Check the reconnecting state and speak a fresh phrase after recovery. Live retains only a short recent uplink window, about 200 ms. Check that an old reply does not play back over the new exchange.
7. End manually, then exercise a spoken end request in a separate session. Check the goodbye, released microphone, closed session, and saved turns. An answered Human turn uses `voice-mode:<turnId>` and a `voice_live_turn` marker. Check for duplicate ordinary Agent replies.
8. Try denied microphone access, unavailable worker, and an interrupted prior phone session. A later start can close its own remembered stale session. Check the session IDs. On a cold worker, verify the first spoken turn reaches the worker and produces audio.

Keep the session purpose `chat_live`, mobile client identity, Room and turn IDs, actual playback, and independently read messages. Record the phone's lack of page tools when checking worker capabilities. The phone exposes Live and recording routes at this revision.

Reuse `voice/live-turns.test.ts`, `voice/bridge-client.test.ts`, `apps/voice-runtime/src/live-worker.test.ts`, and TeamHub `voice_live_test.go`. Fixture events establish turn handling. A real spoken reply establishes the media and model path.

## Use the desktop Voice Mode window

Use the actual Electron desktop app, desktop microphone, LiveKit, and configured Live worker. Start a separate desktop session. Desktop publishes directly to LiveKit. The phone bridge belongs to the phone session.

1. From an empty desktop Room composer, choose `Start Voice Mode`. Confirm the session purpose is `chat_live`. Speak and receive a reply in `Voice Mode window`.
2. Navigate to another Room. Use `Open this conversation` to return to the originating one. Check that the same call continues and its turns belong to that Room.
3. Mute the microphone and independently toggle reply sound. Verify both controls using actual input and playback. Inspect transcript order, scrolling, and retry of a failed turn when offered.
4. Drag, expand, shrink, and resize the in-page window. Choose `Float Voice Mode window`. Check that one window follows the same call across apps. Choose `Return Voice Mode to Linger` and continue speaking.
5. End an in-page session with `End Voice Mode`. In a separate run, close the floating native window. Verify final turns finish, the microphone releases, and a later call receives a new session ID.
6. Exercise microphone denial, unavailable Live service, interrupted connectivity, and unavailable floating-window support. Check the visible refusal or in-page fallback. Recover and confirm a fresh audible turn.

Keep native-window and in-page screenshots, session IDs across float and return, author and Room IDs, and playback observations. A phone Simulator cannot establish desktop window or microphone behavior.

Reuse Web `voice-mode-mini-window.test.tsx`, `voice-mode-session.test.tsx`, and `apps/desktop/src/main/voice-window.test.ts`. The worker's synthetic audio checks complement the native walkthrough.

## Receive and open notifications

Use a physical phone with a push-capable native build, OS permission, and a configured Expo Push Service. The phone's service URL must match TeamHub's trusted service. Use two computers for target switching and two registered devices for independent delivery.

1. Approve the phone and allow notifications. Check phone Settings > `Notifications` and Web Phones > `Push on`. Exercise OS denial and the settings guidance. A build without usable push configuration hides the setting.
2. Background the phone. Cause Another Me to post a visible ordinary message in its direct chat. Check title `Linger` and body `Another Me replied`. Create a pending decision owned by the Human and check `Linger needs your decision`.
3. Compare with the Human's own message, an ordinary group message, and an unrelated Agent message. Check that none creates the qualifying alert. Inspect the qualifying payload for `kind`, `host_id`, `room_id`, and `event_id`. It must exclude conversation text.
4. Tap a notification with the app warm, then cold. With B active, tap A's alert. The app switches to A and opens the indicated Room. Confirm a fresh read through A's approved session. Record the Room destination independently of scroll position.
5. Tap offline and reconnect. Try a malformed Room handle, an unknown host, and an alert from a removed pairing. Check that none opens content under the wrong computer.
6. Turn notifications off online and refresh Web to `Push off`. Generate a new qualifying event. Repeat the toggle while offline. Revocation remains pending until reconnect, so check suppression after Web confirms it.
7. Turn notifications on again and confirm fresh delivery. With a second registered phone, disable or remove only the first. Generate another event and verify independent delivery to the second.

8. Switch Settings > `Language` to Simplified Chinese with a session open. The phone renews its grant; the next alert is in Chinese. Switch back and check English again.

Keep redacted payload field names, notification wording, event and Room IDs, both Web grant states, and the destination after tapping. An injected Simulator notification can verify tap routing. Actual delivery needs Expo and a physical device. A naturally generated Another Me reply also needs a real model.

Reuse `push/grant.test.ts`, TeamHub `internal/mobilepush/mobilepush_test.go`, Relay `internal/push/push_test.go`, and Web `phones-settings-page.test.tsx`. These cover grant refresh, event selection, expired grants, and rate-limited alerts. The Relay test uses a stand-in Expo endpoint.

## Switch the interface language

Use the Simulator. Set the phone's system language to Simplified Chinese, then to English, with Settings > `Language` on `Follow System`. Every screen follows after returning to the app. Pin English, then Simplified Chinese, and relaunch; the choice holds. Check dates in the Messages list, the Library and a meeting in both languages.

Reuse `i18n/catalog.test.ts`, which checks every message has a translation with the same placeholders.

## Save and send diagnostics

Use the Simulator with a disposable message marker and a different Document marker. For sending, use a build configured with an owned `LINGER_DIAGNOSTICS_UPLOAD_URL`. A reachable receiver is sufficient. No model is needed.

1. Send the message, open the Document, trigger a failed request, then background the app to flush logs. Inspect `logs/app.log` and the rotated `logs/app.1.log` when present. Each has a 256 KiB limit.
2. Confirm the logs contain useful events, safe error codes, counts, or timing summaries. Search both files for the exact markers. Check the failure path for quoted user text. Inspect field names for invites, keys, tokens, Document contents, or audio.
3. While offline, tap `Save Diagnostics`. Inspect `linger-phone-log.txt` from the share sheet. It combines the previous and current logs in order. Cancel sharing and return to Settings.
4. Tap `Send Diagnostics`. `Send diagnostics?` names the receiver. Choose `Cancel` and verify zero receiver requests. Reopen and choose `Send`.
5. At the receiver, verify the ticket request uses `linger.diagnostics-upload/v1`, client `linger-mobile`, version, platform, byte size, and SHA-256. Verify one successful PUT of the matching ZIP. Inspect `app.log` and `about.json` and repeat the marker checks.
6. Check that `Diagnostics sent` appears after the PUT. Match its report ID with the receiver. Exercise `Share ID` and `Done`.
7. Try an unavailable receiver, ticket `429` or `5xx`, and an expired upload URL returning `403`. Use `Try Again` and verify a new ticket. Try a malformed ticket, a redirected ticket response, and `413`. Check `Save Instead` where offered.
8. In a build with no valid receiver, verify `Save Diagnostics` remains available. Accepted receiver schemes are HTTPS and loopback HTTP for development.

Keep file sizes, rotation order, field inventory, marker-match counts, ZIP digest, request statuses, and report ID. Record zero matches explicitly. Inspect the local logs as well as the exported copies.

Reuse `lib/app-log.test.ts`, `lib/diagnostics-upload.test.ts`, and the [diagnostics receiver contract](../../../../docs/diagnostics-upload.md). Rotation tests cover the log writer. The marker journey checks what real callers put into it.

## Remove a phone from the computer

Use Web Settings > Phones and an approved Simulator. Add a second phone identity to verify isolation. Use a physical second device if independent push delivery is part of the claim.

1. Select `Remove <name>`. Check the confirmation names the intended phone. Cancel once and send a message. Then confirm removal and refresh the list.
2. With the phone online, observe the active connection close and the subsequent authenticated refusal. Confirm the computer revoked its device session, cleared its push grant, and removed the row.
3. Check the phone's settled screen. After its last pairing is removed, it shows `Pair with your computer`. With B still paired, B becomes active. `Removed this phone` can appear transiently. The normal main screen has no persistent removal banner at this revision.
4. Repeat while the phone is offline. Its local data can remain until it learns the outcome. Restore connectivity and confirm `PHONE_REMOVED` or `PHONE_UNKNOWN`, followed by the same per-computer cleanup as local unpairing.
5. Compare with an ordinary socket interruption. Reauthentication after a temporary drop preserves the pairing. Tap an old notification after removal and confirm it cannot reopen the forgotten computer.
6. Confirm the other approved phone still works. Pair the removed phone using a fresh invite and approval. Check its new phone row and independently read a new message.

Keep phone and host IDs, revocation time, fresh Web list, authenticated resume result, settled phone screen, and per-host storage counts.

Reuse `computer/connection.test.ts`, Web `phones-settings-page.test.tsx`, and `TestMobilePhonePairsActsAndIsRemoved` in `mobile_phones_test.go`. It also checks the refused private Relay and untrusted Push Service from the phone.

## Reconnect after the computer restarts

Use a paired Simulator and an owned computer whose TeamHub database and private seed survive restart. Use an installed Desktop with `Open at login` for the actual reboot branch.

1. Send a baseline marker and record host, phone, Room, and last message IDs. Restart the computer's services. Observe the phone's offline status and retry controls. Queue a message in the already open Room.
2. Restore the same installation. Let automatic retry reconnect. Repeat using `Retry` and foregrounding the app. The original pairing should resume without a QR or approval. Confirm the queued message arrives once.
3. Create Room activity while the phone is disconnected. After reconnecting, verify missed messages, ordering, read position, and incoming updates against a fresh Room read.
4. Perform an actual reboot with Desktop configured to open at login. Check the reminder in Web Settings > Phones. Record when TeamHub becomes reachable, when the Daemon can run tasks, and when voice becomes ready.
5. Separately stop only the Daemon while TeamHub remains reachable. Read or send a message and check `Your computer can't run tasks right now.` Restore the Daemon. Use a real model to verify a subsequent task reply.
6. Exercise the pinned-key mismatch branch with the controlled connection test. Repeated authenticated-handshake failures can lead to `<name> needs pairing again`, with `Pair again` or a switch to another computer. A simple outage should continue retrying. A reset that changes the host ID can instead leave the old host unreachable.

Keep restart scope and timestamps, host and phone identity across restart, fresh message counts, and separate evidence for messaging, Agent execution, and voice. A service restart covers service recovery. Record a machine reboot separately.

Reuse `computer/connection.test.ts`, `session/noise.test.ts`, `session/session.test.ts`, `realtime/room-events.test.ts`, and TeamHub `internal/mobilegateway/session_test.go`.
