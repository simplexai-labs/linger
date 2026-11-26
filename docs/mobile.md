# Mobile App

The Mobile App (`apps/mobile`) is the iOS and Android client of one Linger
deployment. It is an online client of the user's own computer: TeamHub on that
computer stays the single source of truth, and the phone keeps only a read
cache, a queue of unsent messages, recordings it has not delivered yet, and
its keys.

The phone reaches TeamHub over one end-to-end encrypted session. The session
runs over a direct local-network connection when the phone can reach the
computer, and through a Relay otherwise. The Relay (`apps/relay`) joins two
outbound WebSocket connections and forwards opaque frames; it never sees
plaintext and stores no product data. The same binary also runs the Push
Service, which holds the push provider credentials.

Decision records: `docs/adr/0001` to `docs/adr/0004`.

## Parts

| Part                   | Where                                                                                   | Owns                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile App             | `apps/mobile`                                                                           | Screens, per-computer read cache and outbox, phone keys, audio capture and playback.                                                            |
| Mobile Gateway         | `apps/teamhub/internal/mobilegateway`                                                   | The computer's static key, the session responder, the LAN listener, the outbound Relay link, and the dispatch of session requests into TeamHub. |
| Paired Phones          | `apps/teamhub/internal/pairedphone`                                                     | Pairing Invites, Paired Phones and their approval, device Sessions, revocation, push grants.                                                    |
| Mobile push jobs       | `apps/teamhub/internal/mobilepush`                                                      | Deciding which Room Events notify a phone and asking the Push Service to deliver them.                                                          |
| Relay and Push Service | `apps/relay`                                                                            | Host control links, splices, rate limits; push grants and delivery through Expo.                                                                |
| Voice Bridge           | `apps/voice-runtime` (`start --bridge`), proxied by node-services at `/v1/voice-bridge` | Joins the local LiveKit Room in the phone's place and moves audio and Live events both ways.                                                    |

## Keys and identities

- **Computer static key.** An X25519 key derived from `LINGER_SECRET_SEED`
  with the label `mobile-gateway-static-key`. Rotating the seed unpairs every
  phone: its pinned key no longer answers. The Host ID is the lowercase hex
  of the first 16 bytes of SHA-256(public key). The Gateway is off without a
  seed.
- **Phone static key.** An X25519 key the phone generates once per paired
  computer and keeps in the platform keychain
  (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, so locked-screen recording can
  reconnect). TeamHub stores its public key on the Paired Phone row.
- **Device Session.** An approved Paired Phone owns one TeamHub Session row
  whose token hash is random: no cookie can present it. The Gateway attaches
  it in process to every request it dispatches for that phone, so VoiceSession
  ownership and event-stream revalidation work as for a browser and survive
  reconnects. The Gateway replaces the Session when less than 14 days of its
  90 remain or a password change revoked it; a password change does not
  unpair phones, because the phone key, not the password, is their
  credential. Removing the phone revokes the Session and closes its live
  sessions.

## Pairing

1. A signed-in Human opens Settings › Phones and asks for a pairing code.
   TeamHub creates a Pairing Invite: 32 random bytes, stored as a SHA-256
   digest, valid for 10 minutes, usable once.
2. The page shows a QR code for
   `linger://pair?d=<base64url(JSON)>` with:
   `{"v":1,"name":<computer name>,"host_key":<b64url>,"invite":<b64url>,
"expires_at":<RFC 3339>,"relay":<wss origin or null>,"lan":[<ws origins>]}`.
   The Relay URL and Host ID route the connection; only the invite grants
   anything, and it travels only inside the encrypted handshake.
3. The phone scans it, creates its static key, and runs the handshake below,
   first on the LAN origins and then through the Relay, one route at a time.
   Its hello is
   `{"type":"pair","invite":<b64url>,"name":<phone name>,"platform":"ios"|"android"}`.
4. The Gateway spends the invite and records a **pending** Paired Phone with a
   random six-digit confirmation code, in one transaction, and answers
   `{"type":"pending","phone_id","name","code"}`. The phone shows the code.
5. Settings › Phones shows the pending phone with the same code. The Human
   compares the two and approves it; only then does TeamHub create the device
   Session and the Gateway tell the phone `{"type":"approved"}`. Rejecting it,
   or 10 minutes passing, removes it.
6. A phone whose reply was lost retries with `{"type":"resume"}` on the same
   key: a spent invite never pairs twice, and the pending phone answers again
   with its code.

The Gateway accepts at most 10 pairing hellos per minute, independently of
password login.

## Session protocol

- Handshake: `Noise_XK_25519_ChaChaPoly_SHA256`. The phone is the initiator
  and already knows the computer's static key from the QR code. The prologue
  is the ASCII string `linger-mobile/1` followed by the 32-byte computer
  public key.
  1. phone → computer: `e, es` with an empty payload.
  2. computer → phone: `e, ee` with an empty payload.
  3. phone → computer: `s, se` with the hello JSON as payload. The phone's key
     and hello are protected by the forward-secret keys of the first two
     messages.
- After message 3 both sides split the transport ciphers. The computer's
  first transport message is the welcome JSON (not a frame):
  `{"type":"welcome","phone_id","name","lan":[...],"relay"}`,
  `{"type":"pending","phone_id","code"}`, or `{"type":"error","code"}`
  followed by a close. Refusal codes: `PHONE_UNKNOWN`, `PHONE_REMOVED`,
  `INVITE_INVALID`, `PAIRING_EXPIRED`, `RATE_LIMITED`, `BAD_HELLO`,
  `UNAVAILABLE`.
- Transport: every later WebSocket binary message is one Noise transport
  message (at most 65,535 bytes) carrying one frame. Noise counters reject
  replayed, dropped or reordered messages; any decryption failure closes the
  socket. Application data flows only after the handshake completed.
- A new connection always runs a new handshake with fresh keys, including
  after a route change. There is no session resumption across sockets.
- A phone treats a handshake failure against its pinned key as "this computer
  changed" and asks to pair again; it never accepts a new key silently.

### Streams inside the session

Plaintext transport messages are frames:

```
u8 type | u32 stream (big endian) | payload
```

| Type | Name       | Direction        | Payload                                                    |
| ---- | ---------- | ---------------- | ---------------------------------------------------------- |
| 1    | `request`  | phone → computer | JSON `{"method","path","headers"}` opens an HTTP stream    |
| 2    | `data`     | both             | raw bytes of a body or one binary socket message           |
| 3    | `end`      | both             | empty; the sender finished its half                        |
| 4    | `response` | computer → phone | JSON `{"status","headers"}`                                |
| 5    | `reset`    | both             | JSON `{"code"}`; the stream is abandoned                   |
| 6    | `socket`   | phone → computer | JSON `{"path"}` opens a message stream to the Voice Bridge |
| 7    | `text`     | both             | one UTF-8 socket text message                              |
| 8    | `control`  | both             | JSON on stream 0: `ping`, `pong`, `approved`               |
| 9    | `window`   | computer → phone | u32 big-endian credit for a stream                         |

- The phone opens odd stream IDs. At most 64 streams are open at once.
- Bodies travel in `data` frames of at most 60 KiB. The phone may send at
  most 256 KiB on a stream beyond the credit the computer granted; the
  Gateway grants credit as TeamHub consumes the body, and closes a session
  that overruns it.
- The Gateway streams a response as TeamHub writes it, so Server-Sent Events
  and downloads work unchanged. Frames of socket streams (voice) leave before
  queued frames of request streams, so a download never delays audio.
- A pending phone may send only `control` frames.

### What a session may reach

The Gateway dispatches a `request` into TeamHub's own HTTP handler in process,
never through the Web host. It accepts only method and path pairs on the
Mobile API allowlist (`internal/mobilegateway/allowlist.go`), each one a
public contract operation the Mobile App uses; everything else answers 404
`NOT_AVAILABLE_ON_MOBILE` without reaching TeamHub. Sign-in, password,
logout, local identity, Computer enrollment, Document editing credentials,
pairing administration, Agent Runtime, internal and Agent API routes are not
on it. The Composio and web search keys are on it only as far as a decision
card asks for one: saving that key answers the card. The Gateway removes `Cookie`, `Authorization`,
`Origin`, `Referer`, `Accept-Encoding` and forwarding headers, then attaches
the phone's device Session. `WEB_PUBLIC_ORIGIN`, cookies and CORS are
untouched because no request leaves the process.

A phone answers every decision card kind. Two can only be declined there,
because what they ask happens on the computer itself: `browser_connection`
(connecting that computer's Chrome) and `computer_permission` (granting a
macOS permission on that Mac). A `connection_auth` card, and the Connect step
of an AnotherMe apps card, open the app's OAuth page in the phone's browser;
the page it returns to is the computer's own address, which the phone cannot
load, so TeamHub's own checks of the pending Connection finish the card.

One operation narrows further for a phone. `POST /v0/mobile/relays` refuses a host that is, or resolves to, a
loopback, private or link-local address with 403
`RELAY_PRIVATE_FROM_PHONE`; only the computer adds such a node. A push grant
must name the Push Service the computer trusts,
`TEAMHUB_MOBILE_PUSH_SERVICE_URL` (by default `https://relay.heylinger.com`),
or it answers 400 `PUSH_SERVICE_NOT_ALLOWED`.

## Relay protocol

The Relay keeps no state beyond the hosts online now and its rate-limit
counters. It can see connection timing, sizes, the Host ID and client
addresses, and it can delay or drop traffic; it cannot read or alter it.

- **Host control link.** The Gateway dials `wss://<relay>/v1/host`. The Relay
  sends `{"type":"challenge","relay_key":<b64url X25519>,"nonce":<b64url>}`.
  The Gateway answers `{"type":"hello","host_key":<b64url>,"proof":<b64url>}`
  where `proof = HMAC-SHA256(X25519(host_private, relay_key),
"linger-relay-host/1" || nonce || host_key)`, and the Relay answers
  `{"type":"ready"}`. A newer link for the same Host ID replaces the older one.
- **Phone link.** The phone dials `wss://<relay>/v1/connect/<host_id>`. When
  the host is online, the Relay sends `{"type":"open","conn":<id>,"ticket":<b64url>}`
  on the control link and waits up to 10 seconds for the Gateway to dial
  `wss://<relay>/v1/host/data/<conn>?ticket=<ticket>`. It then forwards
  binary messages both ways until either side closes. Frames the phone sent
  before the splice are held, up to 256 KiB.
- **Spare data socket.** A Gateway whose hello carries `"spares":true` gets
  `{"type":"spare","conn":<id>,"ticket":<b64url>}` on the control link and
  dials `/v1/host/data/<conn>?ticket=<ticket>` at once; the Relay holds that
  socket and splices the next phone onto it without an `open`, then offers
  the next spare. The Gateway starts the handshake clock on the phone's first
  message. This saves the Gateway's dial while a phone waits (about two round
  trips to the node). A Relay that does not know `spares` ignores it, and a
  Gateway that does not send it never gets a spare.
- **Close codes.** `4404` host offline, `4408` host did not answer, `4429`
  too many links, `4413` message too large; HTTP 429 before the upgrade when
  a client address dials too often.
- **Limits.** 70,000 bytes per message, 16 open phone links per host, 30
  phone dials and 10 host dials per minute per client address, pings every
  20 seconds and a 60-second silence timeout.

### Relay nodes

TeamHub keeps one control link to every enabled node in its Relay node list
(`mobile_relay_nodes`, `internal/mobilerelay`), each reconnecting on its own
and logging `mobile.relay_connected` with its `relay`. The list holds the
official nodes, `wss://relay.heylinger.com` abroad and
`ws://47.111.147.142:7787` in mainland China, which TeamHub adds at start, and
custom nodes the Human adds. Official nodes can be turned off but not removed.
`TEAMHUB_MOBILE_RELAY_URL` adds one more node at start (a Quick Install sets it
in the instance's `user.env`); set empty, TeamHub keeps no Relay link at all.
A TeamHub on the public development seed of `pnpm dev` keeps none either:
every such checkout has the same computer key, so phones reach it on the
local network only, and a developer testing a Relay sets a private
`LINGER_SECRET_SEED`.
`GET`/`POST /v0/mobile/relays` and `PATCH`/`DELETE /v0/mobile/relays/{id}`
read and change the list; a phone may list and add nodes, and Settings ›
Phones on the computer also turns nodes on and off and removes custom ones.
A change relinks at once without touching unchanged links. The list holds at
most eight custom nodes (`409 TOO_MANY_RELAYS`). The Gateway checks the
address it actually dials, after DNS, and refuses link-local, multicast and
unspecified addresses; loopback and private addresses stay allowed for local
and LAN nodes. Each control link keeps at most one spare data socket and 32
data sockets, all closed when the control link ends.

A node forwards only end-to-end encrypted bytes and the phone pins the
computer's key, so a node on an IP address may serve plain `ws://`; the
mainland node does, because a mainland domain needs a filing.

The pairing code carries the first four enabled nodes and every welcome
carries all of them as `relays`, `{"id","url","label"}` in list order, and
`relay`, the first node's URL, for phones that know only one. An empty
`relays` means every node is off. A phone keeps reading `relay` alone from a
computer that sends no `relays`. docs/adr/0005 records why.

### Choosing a route

The LAN listener serves the same `GET /v1/connect/<host_id>` path. Before
the upgrade it allows each client address 30 connections a minute and holds
at most 64 at once. A phone uses one client for both routes. For an already paired phone each round dials every stored LAN
origin at once and the Relay nodes 300 ms later, and keeps the first session
that completes its handshake:

- **Automatic** (the default) dials the node with the shortest request round
  trip the phone remembers first and every other node 250 ms later, or at once
  when the first fails.
- **A pinned node** is the only Relay node dialed, while the computer still
  lists it, and the only one timed, so no other node sees the phone.

Once per launch, after its first session opens, and whenever Settings,
Relay opens, the phone opens a short session through every node and stores
the median of three `GET /v0/session` round trips per node; that is the time
Settings shows. Opening a session costs more (TCP, WebSocket and Noise
through the node), but the round trip is what every request pays. The welcome refreshes
the stored LAN origins and nodes after a change, so a new node needs no new
pairing. On iOS a denied Local Network permission only removes the LAN
route.

A session on a Relay does not stay there once the LAN is back. On a network
change, on returning to the foreground and every 30 seconds, the phone dials
only the stored LAN origins in the background, leaving the open session
alone. When one completes its handshake it becomes the session and the Relay
session closes; that close starts no new round and no backoff. A failed LAN
dial changes nothing, and only one runs at a time. While a voice call holds a
socket stream the session keeps its route. Requests cut off by the switch
fail as a closed session: queries retry, the event stream resumes from its
cursor, the outbox resends with the same `Idempotency-Key`, and an
attachment upload is sent once more with its own key.

## Voice

Dictation, Live voice mode and meeting recording keep the computer's existing
LiveKit pipeline and its workers. The phone:

1. Creates a VoiceSession through ordinary session requests
   (`POST /v0/rooms/{id}/voice-sessions` with `"client":"mobile"`) and asks
   for its connection credential
   (`POST /v0/voice-sessions/{id}/connection-credentials`). The credential
   never leaves the computer's side of the session in a form another device
   could use, and each request for it advances the publisher generation as
   for a browser.
2. Opens a `socket` stream to `/v1/voice-bridge` and sends
   `{"type":"start","voice_session_id","credential","purpose","sample_rate":24000,"resume_from"?}`.
3. Waits for `published`, then sends audio as `data` frames: a u32 big-endian
   sequence number, then 20 ms (at most 100 ms) of signed 16-bit little-endian mono PCM at
   24 kHz.

The Bridge (`apps/voice-runtime`, `start --bridge`, behind node-services) checks
that the credential is this computer's LiveKit grant for
`publisher-<voiceSessionId>` in the Room `voice-<voiceSessionId>`, joins that
Room on the computer's own `LIVEKIT_URL` (never an endpoint the phone names),
and publishes the microphone track exactly as a browser would. It replies
`{"type":"published","track_sid","generation"}`, where `generation` is the
grant's publisher generation. The phone then waits for readiness the way a
browser does: it reads `GET /v0/voice-sessions/{id}` until
`input_ready_generation` equals `generation`; there is no separate readiness
report. The Bridge plays audio at real time and acknowledges it with
`{"type":"ack","through":<seq>}` about twice a second and as soon as all
received audio has played. An ack means LiveKit's audio source has played
the audio out, not only queued it, so before
ending a dictation turn or stopping a recording the phone waits for an ack of
its last frame.

For `chat_live` the Bridge subscribes to the Live worker's reply track and
sends it back as `data` frames of raw PCM: signed 16-bit little-endian mono
at 24 kHz, 20 ms per frame, with no sequence number. It forwards Live data
packets (subtitles, turn completion, interruptions, tool requests) as `text`
frames `{"type":"live","payload":{...}}`; the phone's
`{"type":"live","payload"}` messages are published back on the same topic,
reliably. Reply audio and Live packets that arrive while no stream is
attached are dropped. `{"type":"stop"}` leaves the Room at once, discarding
audio not yet played. One Bridge participant serves one VoiceSession; a
newer stream for it replaces the older one, which the Bridge closes with
code 4001 and whose frames it ignores.

**Drops.** When the phone's stream drops, the Bridge stays in the Room. The
phone keeps every unacknowledged frame and, on a new stream with
`resume_from` and the same credential, resends them; the Bridge skips every
sequence number it already received, played or queued. Only the phone that
started the session may resume it. Dictation and recording replay at real
time, so nothing is lost or doubled and the transcript lags by the length of
the drop. The phone holds at most the newest 200 ms of Live audio before
the Bridge publishes and drops older audio, because the Bridge plays at
real time: audio held there stays as delay for the whole call. A `start`
without `resume_from` begins a new Bridge session for the VoiceSession, and
a credential of another generation makes the Bridge rejoin the Room with it.
The Bridge holds a dropped VoiceSession for 10 minutes; after that it leaves,
the computer closes the Capture as usual, and the phone, which records every
meeting to a local file as well, attaches the complete local recording to
the Another Me chat so no audio is lost.

**Live without a page.** A VoiceSession the Mobile App creates is marked
`client: "mobile"`. The Live worker then offers no page tools (`read_page`,
`page_action`) and keeps `end_voice_mode`.

Audio budgets: the phone keeps at most 10 minutes of unacknowledged audio
(about 29 MB); the Bridge queues at most 1 second for Live and 10 minutes for
dictation and recording. Past that it sends `{"type":"error","code":"BACKLOG_FULL"}`
and closes the stream; the phone resumes once acks show the queue played
down. The Bridge serves at most 8 VoiceSessions at once.

Errors arrive as `{"type":"error","code"}` before the Bridge closes the
stream: `BAD_START`, `CREDENTIAL_INVALID`, `SESSION_MISMATCH` (another phone
or purpose), `TOO_MANY_SESSIONS`, `CONNECT_FAILED`, `BACKLOG_FULL`,
`BAD_FRAME`, `ROOM_CLOSED` (the VoiceSession's Room ended) and
`SHUTTING_DOWN`.

## Push

The Push Service runs in the Relay binary only where its provider
credentials are configured; the official deployment does. A self-hosted Relay
does not need it: every phone uses the official Push Service.

1. After each session opens, the phone gets its Expo push token and asks the
   Push Service for a **push grant** for this computer:
   `POST <push>/v1/push/grants {"expo_token","host_id","language"}` →
   `{"grant","expires_at"}`. The grant is sealed with the service's key,
   names the Expo token, the Host ID, the phone's interface language and an
   expiry 30 days out, and is useless to anyone without the service. The
   phone asks again when its interface language changes; a grant without a
   language, or with one the service has no text for, gets English alerts.
2. The phone gives the grant and the Push Service's https origin, never the
   raw token, to its computer: `PUT /v0/me/phone/push-grant
{"grant","service_url"}`.
3. When a Message is published, a database trigger on `room_events` enqueues
   a River job (`mobile.push`) in the same transaction whenever a phone holds
   a grant. The job (`internal/mobilepush`) decides whether the Message
   qualifies, as described below, and sends `POST <service_url>/v1/push/send
{"grant","kind","handle"}`. A `410` or `401` answer drops the grant; a
   `429` drops that alert.
4. The Push Service checks the grant, that its Host ID matches the handle,
   its expiry and quotas per device, whatever grant names it (30 a minute,
   300 a day), and sends a
   generic alert through Expo with enhanced push security on. The alert's
   `collapseId` and Android `tag` are its kind and Room, so a Room's next
   alert replaces the last instead of stacking, and `threadId` groups a
   Room's alerts. A decision asks for `time-sensitive`, a reply `active`; iOS
   treats `time-sensitive` as `active` while the app lacks that entitlement. It is
   enabled by
   `RELAY_PUSH_SEAL_KEY` and `RELAY_PUSH_EXPO_ACCESS_TOKEN`
   (`apps/relay/README.md`).

| Kind       | When                                                                                                             | Alert text (English)         |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `message`  | An Agent's turn ends with a reply in the Human's direct chat with it, or a group message that mentions the Human | "You have a new reply"       |
| `decision` | A decision card for the Human is created                                                                         | "Linger needs your decision" |

The Push Service also holds the same two texts in Simplified Chinese
(`zh-CN`) and picks by the grant's language.

A phone hears about a turn once, not about each of its messages, and not
while the Human is already looking:

- A reply waits 30 seconds (`ReplyDelay`) and then alerts only if no later
  Agent message in the direct chat superseded it, no Agent in the Room is
  still running without having replied (for up to 10 minutes), and the
  phone's Human has not read that far on any device. A decision alerts at
  once, and only the phones of the Human it asks.
- Neither alerts while the phone's own Human looked at the Room in the last
  30 seconds; another member looking does not count.
  The Web sends `POST /v0/rooms/{id}/presence` every 20 seconds while a Room
  is visible and in use, and the phone does the same while a chat is on
  screen and the app is in front.
- Each phone chooses, in Settings, Notifications, whether to hear about
  replies and decisions, and whether to hear even while the Human is looking
  at the chat elsewhere: `PUT /v0/me/phone/push-preferences
{"replies","decisions","when_active"}`, by default on, on and off. A
  change made offline is sent on the next session.

The `handle` is `{"host_id","room_id","event_id"}`: tapping the alert opens
that computer and Room and reads the content through the session. A push
reveals the kind of event and when it happened, never its content. Removing
the phone or turning pushes off clears the grant; an old grant stops working
when it expires.

## Phone storage

Everything the phone keeps belongs to one paired computer: keys, read cache,
outbox, Room cursors, recordings, and the push grant. Unpairing, or learning
that the computer removed the phone, deletes all of it. The read cache keeps
recent messages and meeting lists only; Document bodies and audio are not
cached. The outbox keeps each message's destination, idempotency key and body
until the computer acknowledges it; a retry sends the identical request.

## Availability

The phone shows three states separately: the computer is reachable, Another
Me's Computer is online to run tasks, and voice is configured. Reaching
TeamHub does not mean Agent tasks run: quitting Desktop stops the Computer
Daemon while TeamHub keeps serving. Settings › Phones reminds the Human to
keep Desktop's "Open at login" on, because the local services start only with
Desktop after a reboot.

## Reading

- Documents and Wiki pages are read-only. A file Document, Wiki pages
  included, reads its current Version from
  `GET /v0/document-versions/{id}/content`, which needs only read access
  (Wiki pages cannot be exported). A native Document reads
  `GET /v0/documents/{id}/downloads`, which needs export permission and
  retries a `202` after `Retry-After`. Markdown, text, code, images and audio
  render natively; generated knowledge pages hide their leading metadata
  block. Files up to 50 MB that the desktop previews (PDF, Word, Excel,
  PowerPoint, CSV and TSV, HTML, Mermaid, other images and video) are
  downloaded into the cache and shown in the app by an offline viewer page
  in a WebView, built from the desktop's libraries
  (`apps/mobile/viewer`). The page reads only the file beside it, its
  Content-Security-Policy allows only `file:`, `data:` and `blob:`, and an
  HTML file renders in a sandboxed frame with no scripts. Larger files, and
  files the viewer cannot read, open in the system viewer, which the header's
  share button also offers.
- The interface language is chosen per phone in Settings, Language: Follow
  System (the default), English or Simplified Chinese. Dates follow it.
- The Library has three tabs: Meetings by day, recent Documents, and the
  personal Wiki (`GET /v0/tenants/{id}/personal-wiki/documents`).
- Meetings list from `GET /v0/tenants/{id}/memory` and play their recording
  from its Document Version with range requests.
- Decision cards with kind `question` and `approval` are answered on the
  phone with their full details and screenshot; other kinds say "Open on
  your computer". A stale card version refetches the card.
