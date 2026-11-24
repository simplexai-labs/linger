# Web: Vite React Product Client for TeamHub

React Router Data Mode and TanStack Query power the active Room-first UI.

## Common Commands

- `pnpm --filter @linger/web test <test-file>`: run one test. Use the script, not `exec vitest`: it disables Node's experimental Web Storage, which hides jsdom's `localStorage`.
- `pnpm --filter @linger/web typecheck`: typecheck Web.
- `pnpm --filter @linger/web test:build`: run real Vite build configuration tests (`*.build.test.ts`, also run by `make check-web-build`).
- `make check-web`: run Web types, tests, and React diagnostics. Run this
  before opening a pull request. If the change adds a static import on the
  Room or app initial graph, also run `pnpm --filter @linger/web run
build:assets` to check the initial JS budget.
  CI runs it as `make check-web-static` plus `make check-web-tests` in two
  shards (`SHARD=1/2` and `SHARD=2/2`).

## Structure

- Connector authorization uses the Web completion route or, when the desktop
  bridge is available, its one-time browser callback. The signed-in desktop
  page asks TeamHub to verify the return and refreshes its connector queries.

- `src/app`: routes, providers, route error boundaries, and global CSS.
- `src/features/teamhub`: Human API, Session, error, and realtime adapters.
- `src/features/rooms`: Room routes, Chat, Timeline, the right sidebar (Agent Info, Activity, Thread, Document) and membership UI.
- `src/features/web-search`: web search backend queries, bundled provider
  logos and the key field. The chat's search key card reads the backend list
  with `include_quota=false`, so it never makes TeamHub call a provider; the
  Connectors Web search group reads it with live quota. Saving a key or the
  default from either refreshes both.
- `src/features/local-models`: Settings › Models (`settings/models?computer=<id>`).
  Its tabs read and switch the Computer's model source (Local model, BYOK)
  through TeamHub's `model-source` API, which asks the Computer live; the page
  offers no switch to Subscription, and a Computer already on one opens on
  Local model; the page never holds a saved API key (reusing a saved key only
  for the saved endpoint's origin, clearing entered keys after saving, offering
  manual model ID entry even when endpoints list models, and disabling BYOK
  edits while offline). BYOK addresses requests as base URL + path + endpoint
  and sends the format the address's ending names (else the Runtime's own);
  it lists models only on request and shows a Test result as a floating
  message, with the Computer's own message for endpoint refusals; switch
  failures also surface the Computer's diagnostic detail for
  `BYOK_GATEWAY_FAILED` (from the `gateway` detail entry) and BYOK endpoint
  refusals. A switch
  refused with `AGENT_HAS_ACTIVE_RUNS` retries with `force_terminate` only
  after the owner confirms. The Local model
  tab is one Computer's model library as TeamHub last stored it. The Computer
  decides fit, availability, placement, the recommendation and memory; the page
  only orders and labels them, picks the Make room default (including
  external-app cleanup & `Recheck memory` prompts when other apps occupy pool
  memory or unified memory is constrained), shows an explicit `Memory guidance`
  banner and `Recheck memory` button (`POST .../local-models`), lets owners
  pick among installed local models in `SwitchToLocalNotice` or click
  `Use for Agents` on a loaded row, highlights Thinking Machines' Inkling 2
  Mini in a featured spotlight frame (`featured-model-spotlight.tsx`) wrapping
  its grouped `ModelRow` so status, sibling quantizations and actions stay in
  one place (matched via `@linger/service-kit/featured-models`, preferring a
  hardware-fitting `DRIVER_UPDATE_REQUIRED` variant over a
  `MEMORY_INSUFFICIENT` one, moving below `Available to download` when
  unavailable while other models fit, and degrading to a partner highlight with
  external links when absent from the catalog), guides owners through outdated
  NVIDIA drivers via `UpdateDriverDialog` (`local-model-driver-dialog.tsx`)
  with engine-scoped driver guidance, signed one-click Windows installation
  with live progress and post-reboot resume banners
  (`window.lingerDesktop.driverUpdate`), desktop NVIDIA App launch, copyable
  Linux commands, and focus-triggered rechecks, groups sibling quantizations of
  the same logical model (via structured `source_url`) into a single card with
  a clean base title and right-aligned quantization pill (interactive pill
  switcher for multiple versions, matching static pill for a single version)
  while keeping any extra active on-computer variants visible, splits the list
  into `On this computer`, `Available to download`, and a collapsible
  unavailable/needs-more-memory disclosure (auto-expanded when nothing fits),
  renders tinted family icon tiles, download + memory/VRAM (and hybrid
  VRAM + RAM for PolyStrata) footprints on available and loaded rows,
  explicit VRAM vs RAM shortfall copy (`memory_kind`), Agent usage counts,
  structured engine pills (`PolyStrata` / `llama.cpp` / `Strata`, hiding
  redundant `llama.cpp` pills on single-engine hosts while keeping multi-engine
  version switcher pills compact when quantizations are distinct),
  capability/parameter/context badges (never matched against
  `name` or `description`), state-distinct cards (`loaded`, `recommended`,
  `failed` with short failure reasons and direct `Remove` for damaged/missing
  files, `unavailable`), download speed/ETA, live Bifrost (`Pi`) `Gateway`
  readiness, and top diagnostic callouts with a two-column model-card facts
  grid (including `Engine`, `Concurrency`, and hybrid `System memory`) from
  structured `LocalModel` fields in `local-models-rules.ts`, resolves
  Sponsor-owned Agent eligibility and `Pi` runtime switch payloads in
  `local-model-agents.ts` (`Use with <Another Me>`, `Open chat`,
  `Switch Agent…` in `Used by`, and `Make room` automatic Agent handoff once
  the replacement model loads when `Pi` is ready), and maps every code and enum
  label to English in `local-models-copy.ts`. Without `?computer=` the page
  reopens the last owned Computer chosen in this browser
  (`last-models-computer.ts`, cleared on logout), else the desktop app opens its
  own Computer and a browser prefers an online Computer. The header
  `ComputerPicker` (`computer-picker.tsx`) shows connection dots and orders
  online Computers first, and once more than 10 Computers exist it adds
  in-popover search plus `All` / `Online` / `Offline` status filtering. Only the
  Computer's owner can act; actions return at once and progress arrives as
  `local-models` invalidation hints (while `directory` hints and model-source
  switches keep `Used by` and Agent registrations synchronized). From the click
  until a snapshot with another status, error code, or observation time, or a
  refusal (or while offline), the row shows a requested load or download as
  started, labels a cancel, unload or remove under way (Cancelling, Unloading,
  Removing), and spins that action's button, with the row's actions off; a
  download the Computer accepted can be cancelled before its first progress. A
  `loading` row with `concurrency_probing: true` labels its status
  `Probing max concurrency` (`statusProbingConcurrency`) until the one-time
  concurrency probe finishes and publishes `loaded` with the verified
  `concurrency`.
  Make room filters stale unloaded IDs out of `unload_first`, lists what else
  holds the pool (components and other apps) when unloading models cannot free
  enough, and says a model cannot fit only when it needs more than the pool's
  total. When the pool reports `external_holders`, only those apps count as
  Other apps and the rest of the `used_bytes` no holder accounts for shows as
  System & engine; without the field, all of that rest counts as Other apps.
  Opening the page or
  reconnecting an offline Computer auto-refreshes `model-source` and triggers a
  fresh `POST .../local-models` memory snapshot for the owner, while
  `LOCAL_COMPUTER_OFFLINE` disables BYOK edits immediately. A Computer's detail
  on the Computers page links here, reads `model-source` for its active runtime
  pill, and reads no local model library state itself.
- `src/i18n`: the interface languages (English and Simplified Chinese).
  `messages.ts` re-exports the React-free core from
  `@linger/service-kit/messages`, which the desktop shell shares,
  `language.ts` holds the language on screen and the stored choice,
  `desktop-language.ts` reports a stored choice to the desktop app so its
  menus and pages follow, `use-translation.tsx` is the React side, and
  `locales/` holds one catalog per translated language plus its glossary,
  which the desktop catalog follows too.
- `src/test`: unit-test support, including the in-process TeamHub test server.
- `e2e`: Playwright product workflows; every spec runs on the real TeamHub and
  Document Runtime stack (`make check-e2e-room-document`).

## Important Conventions

- The first-visit Agent introduction uses its display name from TeamHub,
  including the default `Linger` name and any name the Human chooses.
- The login page keeps Linger's headline and day timeline on the left,
  and the sign-in form on the right. A faint white grid fades gently into the
  form's white background without a dark panel, colored glow, or blur. The
  timeline speaks in the first person and uses dark and muted text on white;
  reduced motion holds its first nudge still. Below 64rem the illustration is
  hidden, while the form keeps its visible labels and optional desktop account sign-in.
- Login body copy uses the Room font and chat body typography tokens. Times,
  dividers, and the footer use the chat metadata tokens. Its titles keep their
  own scale, with desktop content inset toward the middle on both sides and
  the left copy and timeline inset by two additional 40px grid cells. Linger
  uses the red panda portrait on its warm brown tile.
- The login header uses the transparent horizontal Linger wordmark in
  `public/linger-wordmark.svg`, with the proportions of `assets/logo-horizontal.svg`.
- The Another Me Chat opens with a danger banner while TeamHub's Another Me
  carries `background_failure` (three or more failed background model calls
  in a row), worded from its reason code (an unknown code reads as unknown).
  It cannot be dismissed and goes once a background call completes.
- Switching between Meeting and Voice Mode ends the previous session and
  releases its microphone before the new mode starts. Meeting saving can
  continue in the background. The sidebar Meeting entry spins only while a
  Stop or save is under way: a transcript recovery shows its attempt
  ("Recovering 2/8"), and a Stop that failed three times or a failed recovery
  shows a red dot and opens the window on its Retry without starting a new
  recording. If browser activation expires during the
  switch, the new mode opens in the page and can be floated from there.
  During Live, the Meeting entry offers to start a new Meeting even while an
  earlier one is saving. Both in-page voice windows retain a visible, draggable
  title bar: dark in browsers, the window's own surface colour in the desktop
  app. Picture-in-picture keeps the browser title bar. The desktop app floats
  them in its own always-on-top window, which stays up while the main window
  is minimized or closed to the tray: when the preload offers
  `window.lingerDesktop.voiceWindow`, `voice-pip.ts` opens it with
  `window.open("")` (the desktop main process allows only that call) and is
  the only place that knows which kind of window it got. A desktop app without that field keeps voice windows
  in the page with no float button. In the page on macOS they stay out of the
  window drag strip. In the page both windows resize by any edge or corner
  (`voice-window-resize.tsx`), down to a minimum size and never past the
  viewport; the corner grip also takes arrow keys. Dragging the title bar
  keeps the whole window inside the viewport too, and a window that grows
  where it sits, or whose viewport shrinks, moves back in. Neither window can
  be taller than the viewport leaves room for, so the header stays reachable.
  The size lasts while the window is open and is not stored. Voice Mode's expand button switches
  between its two preset sizes and drops a dragged size; a minimized
  recording resizes in width only. A floated window has no handles: the
  browser or the desktop app resizes it.
- The compact primary rail reveals labels on hover and keyboard focus without
  moving link hit areas or neighbouring links. A stationary pointer at an edge
  must not trigger repeated hover enter/leave; sidebar expansion and Chat list
  collapse remain explicit button actions. Pointer movement only resizes during
  an active drag; keyboard resizing and double-click reset remain available.
- Opening Meeting from the sidebar requests the initial picture-in-picture
  size so a new expanded recording cannot inherit the browser's cached
  minimized window bounds. Floating an existing in-page recording keeps the
  browser's usual placement behavior.
- Recording picture-in-picture collapse remembers that window's actual
  expanded outer dimensions and restores both dimensions with an absolute
  resize inside the user's click, bounded by the current screen. A pending
  native resize must not replace the saved expanded size with collapsed
  metrics. Collapse never closes the window or stops the recording; native
  window placement remains under browser control. Stop preserves the current
  recording view and window dimensions. A minimized window, in the page
  (including the desktop app) or picture-in-picture, shows the confirmation
  actions side by side within its control row in place of Pause and Stop, so
  they stay on screen wherever the row sits and never draw over the controls;
  the timer stays beside them while it fits. An open window keeps the vertical
  confirmation card. Escape or Keep recording returns focus to Stop.
- Recording and Voice Mode distinguish the native window's close action from
  back to tab through the shared PiP return detection. Back to tab keeps the
  session running in the page and exposes a Float action; close ends it.
  Every floated window also draws its own return button, in the browser and
  in the desktop app: `returnVoicePipToPage` brings the tab or the main
  window to the front, reports the return itself and closes the floated
  window. Voice Mode then opens the Room the call started in; a recording
  stays on the page the main window shows. The desktop app's window has no
  back to tab button, so every other close of it ends the session.
  Recording moves one portal host between documents so paused state, Ask
  drafts and transcript scroll survive the move. Hide it while classifying a
  native close, and ignore a late result after unmount or a replacement window.
- Pausing a recording mutes the shared microphone for that recording only:
  the microphone track can outlive it, so a new recording turns the
  microphone back on before it starts, and Start on a running paused
  recording keeps it paused.
- Gmail and Outlook message approvals show the subject and recipients once.
  The subject row toggles the preview and owns its hover highlight; the
  recipient line stays outside the control. The shared AutoHeight transition
  and chevron rotation use the chat resize timing and reduced-motion setting.
  Expanding replaces the compact recipient line with read-only
  From/To/Cc/Bcc headers, followed by the full body and attachments. An empty
  Cc row reads None; Bcc appears only when populated. Email
  actions are Send and Don't send; declining does not request a reason.
- Feishu Mail setup in the connection card and app management dialog reads the
  same account-scoped status. Rechecking does not create a connection or
  open OAuth. The connect action starts authorization after setup is ready.
- A mail canvas (`gmail` or `feishu_mail` target) message segment renders as its email card
  (`rooms/chat/message-mail-canvas.tsx`), laid out like a message approval:
  subject row with open-in-panel and expand controls, recipient line, then
  Send and Don't send, or one receipt line once decided; an unknown result
  keeps Send again and Don't send. Only members who can edit see the actions,
  and with several Gmail accounts a Send from picker chooses the sender.
  Expanding mounts the same collaborative editor as the side panel; Send waits
  until it is saved and posts the digest the card last loaded, refreshed after
  each durable save. Clicking Send is what uploads to Gmail; the side-panel
  canvas has no Send.
- Active product data comes from TeamHub, never retired Workspace APIs. Web has
  no fixture backend and no build mode that swaps TeamHub out.
- Unit tests that need TeamHub use `createTestTeamHubRuntime`
  (`src/test/teamhub-test-runtime.ts`): the real typed client against an
  in-process `TeamHubTestServer` that answers seeded reads. Declare every write a
  test depends on with `runtime.server.on(...)` or an `accept*` helper; an
  undeclared request fails with `TEST_ROUTE_MISSING`. Tests of one client call
  may inject `fetchRequest` (`fetchDouble`) instead.
- Unit tests must not depend on machine speed: rely on the global 5s async wait (Testing Library and `vi.waitFor`) instead of per-test `timeout` options, use fake timers for time-based behavior, and put real Vite/Rollup builds in `*.build.test.ts`.
- TanStack Query owns remote state; route loaders only ensure feature-owned queries.
- Components do not handwrite TeamHub endpoints or wire DTOs. Every TeamHub
  request names a generated contract path through the `openapi-fetch` client in
  `src/features/teamhub/teamhub-api.ts`; SSE, XHR upload, and download URLs use
  its `teamHubUrl`.
- Web never serves the Local Computer release. The Agent Service owns
  `/install/`: the production static host forwards `/install/`,
  `/v1/runner-gateway`, `/v1/local-mcp-relay/`, and `/v1/context-content/` to
  `TEAMHUB_NODE_SERVICES_URL` when it is set, and Vite
  development forwards `/install/` to the local Agent Service listener. Both
  hosts forward the Computer `teamhub` CLI's `/api/agent/` to
  `TEAMHUB_BASE_URL`, so a Computer needs only the Web origin.
  Never bundle installers or CLI releases into Web. The desktop app's own local
  server runs with its built-in Computer and ships no `/install/` release, so
  when `window.lingerDesktop.localServer.owned()` (falling back to
  `localAccount.available()` on older desktop builds) reports true
  (`useCliInstallAvailable`), Web hides standalone CLI daemon download, update,
  and terminal troubleshooting entry points across Computers, LocalComputerGate,
  and Agent creation; browsers and desktop windows connected to a remote server
  keep them.
- Effects owning SSE, WebSocket, polling, timers, or subscriptions may depend only on resource identity; UI callbacks and presentation state must not recreate them. Lifecycle changes require a test proving unrelated rerenders do not resubscribe and identity changes clean up exactly once.
- Browser configuration for local Vite reads `import.meta.env.VITE_*`
  through the app config boundary. Production builds follow the page origin
  (same-origin TeamHub `/v0` and Document Runtime `/document-collaboration`)
  so one image works on every gateway, test environment, and deployed
  environment.
- Use Tailwind and local components; do not add a broad UI library. Render UI icons
  only through `Icon` from `src/components/ui/icon.tsx` with
  `@hugeicons/core-free-icons` (14px in rows and menus, 16px in buttons and the
  rail); `lucide-react` remains only in the Runtime activity views
  (`src/features/rooms/task-sidebar/adapters/runtime-history-view.tsx` and
  `src/features/rooms/runtime-status/runtime-tool-presentation.ts`).
- Styling: Tailwind utilities plus design tokens are the standard. Use token
  classes (Town semantic tokens such as `text-muted-foreground`, or
  `--color-app-*` roles such as `text-app-ink`) instead of hex arbitrary values;
  when no token fits, add one to `src/app/visual-theme.css` and the
  `@theme inline` block in `src/app/globals.css`.
- Input hints use `--app-placeholder` / `text-app-placeholder` across native
  fields, chat composers, select prompts, and editable empty states. Keep
  entered text and adjacent labels on their own text tokens.
- The Room and Thread composers keep the last 50 sent messages of up to
  2,000 characters per draft scope in this browser's `localStorage`
  (`room-drafts.ts`); a full quota drops older entries, and local sign-out
  clears them with the drafts. From an empty draft, ArrowUp on the first line
  and ArrowDown on the last line step through them, with a `History n/N`
  label, unless a picker is open or an input method is composing; unsent text
  is never replaced. Stepping past the newest message empties the composer;
  editing a recalled message makes it the draft.
- Room avatar stacks give each tile an opaque surface behind the member's
  portrait or initials so overlapping members never show through one another.
- Compose conditional class names with `cn` from `src/lib/cn.ts`.
- Do not add CSS Modules or feature-level `.css` files, and do not add new hex
  colors in TSX. Use inline `style` only for runtime-computed values.
- Keep element-level CSS resets (for example `button, input { font: inherit }`) inside
  `@layer base`; unlayered rules beat Tailwind utilities and silently disable `text-*`
  classes. Reference CSS variables for font families with
  `font-(family-name:--var)`, never `font-[var(--var)]`, which Tailwind reads as a
  font-weight.
- Two Tailwind utilities that set the same CSS property are resolved by their order
  in the generated stylesheet, not by their order in the `className` string. Writing
  the one you want last does nothing. Never stack competing `display` or `position`
  utilities on one element, and never pass such a utility to a component that already
  hardcodes one: `.relative` is emitted after `.absolute`, so an `absolute` handed to
  a component whose base classes include `relative` is dropped and the element falls
  back into normal flow; `.block` is emitted after `.line-clamp-*`, so adding `block`
  replaces the `display:-webkit-box` the clamp needs and the clamp stops truncating.
  Put the conflicting utility on a wrapper element instead. Neither typecheck nor
  React Doctor catches this and it renders fine in unit tests, so assert the outcome
  (the wrapper carries the positioning, the clamped node carries no `block`) in a test
  and confirm that test fails when the utility is put back on the same element.
- Interface text on a translated surface comes from a message, not a literal.
  English is the source and the fallback: a string with no translation shows
  its English text.
  - Add a string: declare it in the feature's `*.messages.ts` with
    `defineMessages("<namespace>", { name: "English text" })`, show it with
    `const t = useT()` and `t(messages.name)`, and add the same
    `<namespace>.<name>` to `src/i18n/locales/zh-CN.json` following
    `src/i18n/locales/zh-CN.glossary.md`. `src/i18n/catalog.test.ts` fails when
    a key, a `{placeholder}`, a `<tag>` or a plural form is missing from a
    catalog, or when a catalog keeps a key the source no longer has.
  - Values go in `{name}` placeholders (`t(m.space, { name })`); never join
    translated fragments into a sentence, because word order differs. A count
    is a plural message, `{ one: "{count} file", other: "{count} files" }`,
    called with `count`; a catalog lists the plural forms of its own language.
    An element inside a sentence is a `<name>…</name>` span rendered with
    `RichMessage`, which keeps user-supplied text as text.
  - Outside React (a toast, an error built in a helper) call `translate()`
    when the text is shown, never at module load: a module-level string keeps
    the language it was created in after the Human switches.
  - Dates and numbers inside translated text take `formatLocale(language)`.
    `lib/date-format.ts` stays on `APP_LOCALE` for surfaces that are still
    English, so one screen does not mix an English sentence with a Chinese
    date; a translated surface passes its locale or translation to those
    helpers.
  - A label on a translated surface follows the language, so CSS and DOM
    queries never select by its text. Use a class or a `data-*` marker such as
    `data-voice-area` and `data-chat-composer`, not `[aria-label="…"]`.
  - A translated control tells Voice Mode what clicking it does with a
    marker, never with words in its label: `data-voice-risk="never"` for
    deleting, removing, sending, leaving, signing out, paying, archiving or
    discarding (spoken commands never click it, the live model asks first),
    `data-voice-risk="confirm"` for other decisions such as approve, deny or
    revoke (the live model asks first), and `data-voice-close` on the button
    that closes its panel or dialog. An `ActionMenu` item takes `voiceRisk`.
    `voice-risk-markers.test.ts` fails when a control named by such a message
    lacks its marker.
  - Text this client keeps beyond the screen (the Outbox, saved state) is
    stored as a reason or a key and worded when it is shown, so it follows a
    language switch and a reload. `pending-message-failure.ts` is the pattern:
    the Outbox stores `failure.reason`, the hook words it with `t`.
  - Names and text that people or Agents wrote (Agent names, message
    previews, a published template) are data and are shown as they are.
  - TeamHub's own English is worded here from what it means, never translated
    on the server: a status from its stable code
    (`agent-availability-text.ts`), a card's ask from its kind and fields
    (`card-prompts.ts`). A code or kind this client does not know shows
    TeamHub's English.
  - Errors are worded from the code only when TeamHub's message says nothing
    more (`teamhub-error-text.ts`: expired sign-in, rate limit, server error,
    a response without a TeamHub body). `FORBIDDEN`, `CONFLICT`, `NOT_FOUND`,
    `INVALID_REQUEST` and the like keep TeamHub's message, which says what to
    do; a case worth its own wording needs its own code from TeamHub.
  - Fixed catalog text (`web-search-backend-text.ts`, `app-groups.ts`,
    `builtin-template-text.ts`, `runtime-model-label.ts`) keeps a copy by id
    for other languages only, through `teamHubCatalogText`: English shows
    TeamHub's text, so a change on the server shows at once.
  - Add a language: add it to `LANGUAGES` and `catalogLoaders` in
    `src/i18n/language.ts` and add `src/i18n/locales/<tag>.json`. Catalogs
    load on demand, so English users download none.
  - The choice is stored on the device (`localStorage["linger.language"]`);
    an absent value means no explicit choice, which is English today. Tests
    start in English: `src/test/setup.ts` resets the language after each test,
    and a test of translated text reads the expected string from the catalog
    instead of writing Chinese, which the repository gate allows only under
    `src/i18n/locales/`.
