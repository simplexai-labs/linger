# Local installation core

This package owns instance state, the Native service lifecycle, local account
provisioning and Computer enrollment. The installer service
(`apps/linger-installer`) adapts its structured inputs and redacted events;
the core must not import app source or depend on browser/terminal UI.

Keep instance mutations locked and private state owner-only. Never infer real
Room execution from readiness. Do not reset existing accounts or Computer IDs,
stop unrelated processes, pull mutable images, or delete volumes as recovery.
Every installation runs natively from a Linger source checkout; Docker is not
used.

On Windows `windowsPrivatePath` makes a private path owner-only and refuses it
when another account could put a different folder in its place: an ancestor
that is a link, that another account owns, or that grants another account the
right to replace a child, change permissions, or take ownership. Delete on an
ancestor counts as well, because its holder can rename that folder, except on
a volume root, which can be neither renamed nor removed. A folder directly on
a data drive with the stock root ACL therefore passes, and a folder nested in
one that inherits Modify for Authenticated Users does not. The Daemon's
`privatefs` treats the volume root the same way. A refusal leaves the
installer as its code and reason (`windowsPrivateRefusal`), never as its
words: in the `startFailure` line on stdout when the installer manager cannot
start, and in the `--user-keys` outcome. The Desktop setup page branches on
`UNSAFE_PARENT_ACCESS` to say where to install instead. Repair skips propagation when the protected
DACL already grants inheritable FullControl to the owner and SYSTEM on a
directory, or FullControl to both on a file. Private paths with partial rights
still receive the full repair. Rewriting a directory DACL propagates to its
existing children and can time out on a large cache tree.

Launch the fixed private-path scripts with PowerShell `-Command`. Encoding
the whole script lengthens the Windows command line and can stall startup.
Keep paths and operation parameters in the JSON sent over stdin only.

`atomicPrivate` closes and removes its temporary file on failed writes or
syncs as well as failed publication. A failed replacement keeps the previous
private file available, without leaving partial configuration copies behind.

The account file records provisioning history, not current database readiness
or a promise that its saved password is still current. On HTTP 401, the existing
idempotent owner command establishes whether this email owns the deployment and
can recreate a missing owner without resetting a password. Confirm login after
it: a provisioned owner whose password was deliberately changed remains ready
when the owner command succeeded and login still returns 401. This grants no
session and does not replace saved credentials. A failed owner command, other
login errors, or an unprovisioned account whose login fails must not be treated
as a changed password.

Each instance directory holds `user.env` (0600), the only file a person edits:
`COMPOSIO_API_KEY`, `SONIOX_API_KEY`, `XAI_API_KEY` and `TZ`
(`user-environment.ts`). Every mode merges it into the generated
`compose.env` / `native.env` over a developer checkout's `.env` and under the
installer's own values; other names are ignored with a warning, and the file
is created from a template once; ordinary reads never rewrite it. The desktop source
package's `.env` is not read. Voice keys are normally saved in the app
(TeamHub); a key in `user.env` overrides it. Whenever the distribution has
voice tools for this computer, Native prepares them and runs LiveKit with
the key pair and ports in the instance's `livekit.env`, with or without a
voice key; without them, or when they fail to prepare, TeamHub gets
`TEAMHUB_VOICE_MEDIA=off` and the install continues. The services' `voice`
setting tracks only the tools, so a key change never restarts them through
it. A native process restarts when its generated environment changes.
The desktop passes the system proxy it resolved for Soniox as
`LINGER_SYSTEM_HTTPS_PROXY` (`service-proxy.ts`). When the person set no
`HTTPS_PROXY` themselves, Native gives only TeamHub and node-services
`HTTPS_PROXY` with loopback added to `NO_PROXY`. TeamHub then sends every
https call to the outside through it (voice key checks and file
transcription, Composio, web search, connected-app file transfers), and the
node-services voice workers tunnel Soniox and xAI through it. Native records the proxy in
their settings, so a changed or removed system proxy restarts them on the
next start; without one their settings are unchanged. The installer's own
commands, LiveKit, the local models and the web server never get it.

Adopting a legacy environment keeps nonempty values already set in `user.env`.
Adoption and saved key updates recognize plain, exported and whitespace-formatted
assignments through the same helper. Each changed key replaces its first assignment
in place and removes later duplicates, or is appended once when absent. This keeps
values beside their template comments without duplicate secret values. The legacy
file is removed only after the private atomic write completes.

Generated native values preserve quoted paths and literal backslashes by
checking their complete dotenv file with the launcher's parser. Multiline,
NUL-containing or otherwise unrepresentable values fail before publishing
the environment file.
Every port the installer chooses (`ports.ts`) must be free on both
127.0.0.1 and ::1 with nothing answering there: `localhost` resolves to ::1
first on macOS, and a program on ::1 alone would answer for a service that
bound 127.0.0.1 without an error. The web static host listens on both.
Creating an instance also reserves other instances' saved LiveKit HTTP and RTC
ports, even while their voice services are stopped. Each
start re-checks a stopped service's ports and moves one another program took
to a free port, persisted in `instance.json` or `livekit.env`, so the service
restarts with the new environment. The web port is the product origin
(`instance.origin`, `WEB_PUBLIC_ORIGIN`). For the desktop's instance
(`externalComputer`) it moves like the others: the desktop follows the origin
the installer reports and keeps its Computer and session. A Computer this
installer enrolled keeps the origin once the owner account exists (or a
database set aside from an older install marks it to be made again), because
its self-update source and a pending enrollment credential name it; there it
moves only before that. A moved port is saved without the checkout an
update rebinds to, which `instance.json` names only once the services serve
from it. The account step sends a password only
after the origin's `/v0/local/identity` proof, and a service that stops on a
taken port names the port, instead of a foreign server's answer or a bare
failure.
Every update or recreate path stops node-services on its own, right before
TeamHub restarts (natively: for a changed configuration) and while TeamHub is
still up, so its graceful shutdown requeues in-flight Agent Runs.

`inspectSetup` keeps tool downloads and state in `home`; `targetHome`, when
provided, selects the installation paths to inspect independently of that cache.

The home is `LINGER_HOME`, else `~/.simplexai` (`home.ts`). Installs from
before the product was renamed Linger convert once in
`legacy-migration.ts`, which the installer runs before it opens the home (except
inspection and stop modes) and
the desktop runs through `installer.js --migrate`. Under each instance's lock
it stops the instance's Computer and native services, renames `SIMPLEX_*`
keys in the generated env files, and gives the instance its
`linger-<name>-<hash>` project name. The legacy project name in
`instance.json` marks an instance as not yet converted, so it is written last
and a rerun after a crash converges. A damaged record is skipped. An
instance that fails keeps its legacy names and is returned with its reason;
it does not stop the others or the installer, and the next start tries it
again. `loadInstance` refuses such an instance with an error that says so.
Only something still running keeps an instance unconverted: work its
Computer reports, or a native service that will not stop. A stop that fails
because its program or runtime left with the earlier app (an unreadable
Computer status, a failed idle stop, a recorded PID now owned by another
program, an old gateway's tools) counts as stopped. A Docker-mode record
(`mode` "source" or "release") is never converted or counted as pending:
`loadInstance` refuses it, and its compose project name removes its
containers. The
cache markers `.simplex-files.json` and `.simplex-model-package.json` keep
their names.

Native PostgreSQL runs `initdb` in `native/postgres-data.partial` and moves
it to `native/postgres-data` only once it succeeds, so a killed `initdb`
never leaves a directory that later attempts treat as initialized. A `postgres-data` with
`PG_VERSION` but no `postmaster.opts` (which only a started server writes)
never served a connection, holds no data, and is initialized again.
A running PostgreSQL whose configuration changed restarts like LiveKit and
TeamHub: a release that repins the PostgreSQL archive unpacks it into a new
component folder, so the server an earlier release left running differs in
its executable path and must not stop the install.

On Windows `postgres.exe` refuses a token with Administrators enabled. When
the installer runs elevated (Run as administrator, the built-in
Administrator), its supervisor starts `postgres` through a fixed PowerShell
program (`windows-restricted-token.ts`) from a copy of its own token with
Administrators and Power Users disabled, as `pg_ctl` does; `initdb` already
does this itself. `postgres` stays the supervisor's descendant, so its lease
tree, log and stop work as before. What an elevated process creates is owned
by Administrators; `windowsPrivatePath` accepts that owner as well as the
user when the user is an administrator (Administrators enabled in the token
or in the elevated token UAC links to it, as Git for Windows decides), since
the ancestor check already trusts that group. A standard user is refused.

On Windows the installer stages UTF-8 application manifests beside the bundled
PostgreSQL tools before recording their file hashes. This lets `initdb`
relaunch itself and start `postgres` when the profile path contains characters
outside the system code page. This copy uses the `<archive digest>-utf8`
component directory so older installers can still verify their own cache.
Both copies use the same instance data directory and the same executable path
in the supervisor's configuration hash. A matching live server keeps its
connections during the upgrade. Its next start uses the UTF-8 copy.

The desktop's bundled TeamHub binaries (`teamhub-binaries.ts`) count as current
only when their files still match the manifest's sizes and hashes. A missing
or damaged installed file is copied again from the bundle, so Native can use
the verified binaries without downloading Go and compiling from source.

Every Linger release creates TeamHub's schema from the 852 baseline
migration, which refuses a database that already holds one. A database from
the desktop app before the rename has `public.accounts` but no applied 852
row in `goose_db_version`, so it can never migrate (`legacy-database.ts`).
Once the database is up, Native checks for that; for such a database it
stops PostgreSQL, marks `local-account.json` as not provisioned (so private
login/enrollment reads refuse it until the account step confirms the owner in
the replacement database) and
moves `data/agent`, `data/artifacts`, `computer-enrollment.token` and, last,
`native/postgres-data` into `simplex-backup-<UTC time>` in the instance,
deleting nothing. The database moves last so that a run stopped partway
still finds it and finishes the move, into the same folder when nothing
there would be overwritten. It then opens a
fresh cluster and logs where the data went. The desktop finds the newest backup folder
after the job, enrolls its Computer again once (the old Computer ID is
unknown to the fresh database) and shows the folder on its ready screen.

The Computer config's `local_models` section names the verified localmodels
tool, its `LOCALMODELS_STATE` and model base directory for the Daemon's model
library (`localmodels-computer.ts`). A fresh login passes it as
`--localmodels-*` options; it is part of the managed-runtime fingerprint, so an
existing Computer is rebound once on its next connect. A distribution without
the tool writes none. External Computers (the Desktop's) get the same paths as
the `LINGER_LOCALMODELS_*` keys of the installer's instance runtime. Every
`localmodels` invocation in both the installer and the Daemon also isolates
`LOCALMODELS_TOOLS_DIR` (`<home>/runtime/localmodels/tools`),
`LOCALMODELS_BIFROST_DIR` (`<home>/runtime/localmodels/bifrost`), and
`LOCALMODELS_BIFROST_ADDR` per installation home, stripping inherited values.
The Bifrost address comes from `<tools>/owned.json` (`gateway.bifrost.addr`)
when present, else `<home>/runtime/localmodels/bifrost-addr`, and on commands
that may plan or start Bifrost defaults to `127.0.0.1:18480` when free across
loopback and local interfaces or allocates and persists an ephemeral port free
across local interfaces when `18480` is held by another process; stop and
read-only calls never probe or allocate a port.
A home whose Quick Install ran before per-home isolation (0.1.6 and earlier)
keeps its plan's deployments, Pi profile and Bifrost in localmodels' default
`~/.local/share/localmodels/tools`, so it stays there: when the home has no
per-home `owned.json`, its `runtime/localmodels/plan.json` names a deployment
that the shared `owned.json` owns, every call gets that directory as
`LOCALMODELS_TOOLS_DIR` plus only the Bifrost directory and address its
`owned.json` records, and the choice is recorded once in
`<home>/runtime/localmodels/tools-dir` for the installer and the Daemon to
follow. Isolating such a home would read its deployments as removed and its
plan as changed, and the upgraded app could not start.

Setup sets the Computer's model source through `localmodels source apply`
(`byok-source.ts`): BYOK after the Runtime is ready, a local model after the
stack is, and a subscription after its Runtime installs, signed in or not.
The local source is set only by a start whose request chose local models
(`setupChoice` or a plan approval); a restart or version upgrade from the saved
choice keeps a source the person switched to on the Models page (leaving the
local model stack stopped while `model-source.json` names `byok` or
`subscription`).
The installer reads `model-source.json` (`readByokEnvironment`) but never
writes it. When a deployed local-model stack's binding reports a stopped
service or gateway (`deployment-unavailable` or `gateway-unavailable`) and its
saved plan inputs still match, `prepareLocalModels` starts the installed stack
in place with `localmodels stack up` first (no re-plan against a newer
`localmodels` kit path, live free memory, or retired catalog models; previous
kits under `<home>/tools/localmodels/<sha256>` stay on disk so existing
deployments' launchers remain runnable) and falls back to `stack apply` only
when `stack up` fails or the binding still needs repair (such as
`pi-extensions-unavailable`). Structured `localmodels.stack-error/v1`,
`localmodels.stack-plan-error/v1`, `stack apply` result, and
`localmodels.stack-up/v1` failures are translated to
redacted human-readable messages with their `causeCode` in `details.causeCode`,
and an unreviewable saved plan returns `LOCAL_MODELS_RECOVERY_REQUIRED` with
`STACK_PLAN_INVALID`. `restoreLocalModels` (`local-models.ts`) brings back a
local model source's stack and unloaded library model while its services keep
running (and on cold resume when `model-source.json` says `local`), such as
after the desktop's quit stopped them, whenever the active model source is
`local` (or not saved yet on a `local-models` setup): when a saved
`runtime_model` is recorded, a ready binding checks `library status` so a
quit-time `library unload` reloads that saved model and re-applies the local
source under the same lock (never guessing an arbitrary idle model when no
`runtime_model` is saved), while a stopped plan gets the same restore (`stack up`,
falling back to `stack apply`), verifies whether a saved local model
(`localmodels/` or `localmodels-library/`) is loaded, and sets the local source again. Library-model reload failures return a failure outcome that warm
and cold resume surface in `details.localModelsDegraded` so startup stays usable
and the person can still reach the Models page. The first start after an app
update onto a new checkout passes `degradeLocalModels` without `resume` (it
installs newer runtimes in full) and degrades the same way, so a stack an
earlier release left stopped, which the new kit cannot bring back as saved,
never locks the person out. On cold resume, a saved `local`
source preserves local mode and prepares its runtime instead of letting an older
`setup-choice.json` overwrite `model-source.json` back to `subscription`.
Deployments, that check and the quit-time stop share one lock per home
(`withLocalModelsLock`); the check waits up to 180 s for it, past the stop's
150 s hard exit, then reports `LOCAL_MODELS_RECOVERY_REQUIRED` (or
`LOCAL_MODELS_BUSY` when restoring a library model without a stack plan).
`restoreByokSource` (`local-models.ts`) brings back a saved BYOK source's
Bifrost gateway on every resume (warm, or a restart from the saved choice,
which then prepares the saved runtime and no other source). Under the same
lock, waiting as the restore check does, it skips a loopback gateway whose
`/health` answers, otherwise runs `source apply` from the kit's saved
configuration, so the key never passes through Node. Each re-mount sends
the kit's one small probe request to the person's endpoint and adds a few
seconds to a launch after a quit. A failure (`LOCAL_MODELS_BUSY` when the
lock never frees) is logged and returned as `details.byokGateway`
(`{ code, message }`) of a successful resume, so Linger still opens; the
Computer mounts the gateway again before the next Run on it
(`EnsureGateway` in the Daemon's `internal/localmodels`).

`runProcess` decodes stdout and stderr as separate UTF-8 streams before
capture and output callbacks, preserving characters split across pipe reads.
An output callback failure stops the owned command and rejects its promise
after the process closes; later output is not delivered to a failed callback.

Each native service runs under a detached supervisor
(`native-process-worker.mjs`) whose record holds its PID, birth and an
unguessable lease. On Linux, the supervisor and spawned installer Node
processes (`linuxNodeFdHygieneArgs` in `native-process-fds.ts`) close inherited
non-`O_CLOEXEC` descriptors and listening TCP or Unix sockets >= 3 (keeping the
active IPC channel) so detached services cannot hold parent Electron sockets
open after quit. POSIX finds the service's processes by process group and
the lease in their environment. Windows has neither: the lease is in the
supervisor's command line (its job file name) and the tree follows parent
links (`windowsLeaseTree`), which break when a parent dies first. So on
Windows a stop ends one snapshot of the tree leaves first and the supervisor
last; a supervisor with nothing under it counts as stopped (the PowerShell
of its own process listing does not count as its service); a program file
starts as `source-native.mjs`'s direct child, not through cmd.exe, so it ends
with its supervisor. Before the services start and after a stop, the
installer ends what an earlier run lost track of (`reclaimNativeOrphans`): a
supervisor whose job file is in this instance's process directory under a
lease no serving record holds, and a process on one of this instance's
ports whose command line runs from this installation's folders but belongs
to no recorded service, with its wrappers up to its supervisor. Never by a
program name alone, and never the installer or what started it. If the
recorded PID and creation time still exist but the command line is missing,
stop checks a fresh process listing: CIM can report that incomplete row once
for an exiting process. If the same process remains without a matching lease,
stop fails without signalling it and keeps the record. A start cannot replace
it, and a PID reused by another process does not prevent discarding a stale
record. Readiness on Windows also needs each
port's listener inside that service's tree: an
earlier release's TeamHub or web still on the port would otherwise pass the
health check for a service that could not bind, and a port held by another
program fails the start after 15 seconds instead of at the deadline. The
listener lookup streams IPv4 TCP rows from the Windows system netstat in
parallel with the process listing; process-only inspections need no port lookup.

On POSIX, a start that finds the recorded supervisor gone but processes
still carrying its lease (the app was killed with it) ends them as a stop
does and starts the service again. A live recorded PID or process group
without the lease proves nothing and is refused, never signalled.
On macOS every identity check reads `ps` start times in the C locale.
Linger 0.1.2 recorded them in the locale it ran in; such a record is
converted once to the C-locale birth when `ps` in the installer's own
locale still prints the recorded birth for the live leader holding the
lease, and is otherwise left as it is. A start
that fails before its record is kept ends what it launched: by the lease,
or, when the lease cannot be proved, by the group of the supervisor it has
not reaped yet, whose PID cannot belong to another program. Before the
services start, `reclaimNativeOrphans` also ends, on POSIX, a supervisor
whose command line names a job file in this instance's process directory
under a lease no record holds, once its environment proves that lease; an
attempt that failed or was killed before keeping a record would otherwise
leave PostgreSQL holding `postmaster.pid` against every retry.

The supervisor writes one `[linger-supervisor] <name>` line to the service's
log when it starts the service and for every exit (code, signal, uptime and
whether it restarts). A start with `restartOnExit` (TeamHub, node-services and
web, at `SERVICE_RESTART_POLICY`) makes the supervisor itself start the service
again when it exits unasked, after 1, 2 and then 5 seconds, ending first what
the exited service left under the lease. The supervisor owns the service and
outlives the app, so this also covers a headless install and a closed window.
An exit within the first 10 seconds of the first run is a startup failure the
installer reports, never restarted; five exits within a minute end
supervision with a `gave up restarting` line, the supervisor exits, and the
next resume starts the service as one that is not running. Every intended
stop (`stopNativeProcess`, a configuration restart, quit, uninstall,
`reclaimNativeOrphans`) first writes `<name>.<lease>.stop` beside the record;
the supervisor reads it before deciding and again right before restarting,
and the POSIX stop also kills what holds the lease after the supervisor, so a
restart racing the stop cannot outlive it. PostgreSQL and LiveKit are not
restarted; their exits are logged with `reason=not_supervised`.

Native runtime and localmodels kit verification (`native-runtime.ts` and
`localmodels-tool.ts`) stop assigning files on the first mismatch and wait
for every active verification worker to finish before reporting failure.
Recovery moves or removes an invalid runtime or kit only after those
workers have released their file handles.

Every download offered by both a global host and a mainland-China mirror
goes through `downloadInRegion` (`region.ts`), which tries the home's
download region first and never drops a source; the region is
`SIMPLEX_REGION`, else `<home>/runtime/region.json` (24 hours), else a
best-of-three npm registry probe (up to 1 MiB per round, fastest wins). When
the preferred region fails or transfers slowly while a mirror in the other
region proves faster, the transfer resumes there and rewrites the file. The
probe is shared per home, but cancellation belongs to each caller: one setup
leaving does not cancel another, and the last waiter leaving aborts the probe
so a later caller can retry. Even a cached region respects caller cancellation.
The resolved region reaches every `localmodels` child and native service as
`SIMPLEX_REGION`. The contract is in `scripts/installs/README.md`.

Verified downloads stop reading on explicit cancellation even when a response
body ignores the fetch signal. They retain the caller's abort reason, cancel
the reader and keep only resumable partial bytes; cancellation never waits
for the idle timeout or moves on to another mirror.
Rebuilding the checksum of a saved resumable partial also uses the caller's
signal, so cancellation stops local reads before another request starts and
leaves the partial file intact for the next attempt.
If that saved file already matches the trusted checksum, publish it without
another network request; the usual cancellation and atomic-rename checks still apply.

Move a freshly downloaded or unpacked file or folder into place with
`renameRetrying` from `fs-retry.ts`: on Windows antivirus and indexing hold
new files for a moment, and a plain rename then fails with EPERM.
Cancellation is checked before every rename attempt, including after a
retry wait, so a cancelled installation cannot publish the waiting file.

Verified Windows kit files carry the read-only attribute before publication or
reuse so Python children cannot replace their checked bytecode. The separate
model data and tool state remain writable. Setup can replace a damaged kit
from its pinned archive; quit and uninstall do not download or execute a kit
that fails verification.

Setting `LINGER_LOCALMODELS_DEV_PYTHON` and `LINGER_LOCALMODELS_DEV_MODULE_DIR`
to absolute paths runs a local `localmodels` checkout instead of fetching the
published kit, and `LOCALMODELS_DEBUG` (`simulate` or `tiny`, or
`~/.config/localmodels/debug.json`) passes straight through to `localmodels`.

`installNativeSource` records wall-clock stage seconds (`timings`) in the job's
`details` and logs `Native install timings (s): ...` in the installer event log
without adding contract fields. Each wall-clock second counts toward exactly one
stage on the critical path, so stage durations sum to the total job duration:
`runtime` runs alongside `release`, `images`, and (on overlapped installs)
`migrate`, `services`, and `account`, and counts only the wait beyond that
parallel work, appearing only when the runtime finishes last. LiveKit binds its
saved port before `prepareFoundationServices` on both paths (before the fork
when overlapped), because the model controller asks the OS for a free port. On
fresh installs (`!switchingCheckout`, no
provisioned account unless a legacy backup was set aside, and no running
services) and cold resumes (`resume: true`, `!switchingCheckout`, and no running
services), `migrate`, `services`, and `account` run concurrently with `runtime`,
`prepareFoundationServices`, and `prepareModelGateway`, holding
`services`/`account` `succeeded` events and `saveSourceBinding` until both
branches succeed and aborting and draining both before rollback on failure;
upgrades and live re-runs keep `migrate` sequential after `runtime`. When
`resume: true`, `prepareRuntime` inspects the selected runtime (or a saved BYOK
source's runtime) once and skips
`harness plan` and `harness apply` when it is already installed (falling back to
a full install if missing or unreadable), and passes the inspected descriptor
through `onRuntimeDescriptors` so callers avoid a second status probe. Within
`release`, binary and native-runtime bundle checks run in parallel, while
dependency and voice tool preparations stay sequential on the shared
native-tools lock; collaboration services start concurrently when `node-services`
is not pre-stopped for a TeamHub config restart. `runLocalmodels`
reads the kit's JSON event lines from stdout and stderr alike and forwards
byte progress (`total: null` without a total) and the download
`connecting`, `switching` and `retrying` stages of every command, labeled per
command; a host is shown only when it is a plain hostname, and unknown states
are ignored. `harness apply` also forwards its extract, verify and install
stages. Setup's `source apply` (`prepareByokRuntime`, `applyNativeSource`) may
download Bifrost first, so it forwards these events and has no wall-clock
limit: `idleTimeoutMs` (240 s, above the kit's longest silent span, the BYOK
endpoint probe of up to about 35 s followed by Bifrost's health wait of up to
180 s) stops it only after that long with no output. The resume mount
keeps its 90 s wall clock. `prepareByokRuntime` logs elapsed time every 10 s while mounting
the BYOK gateway (a log line, since the job appends and persists every stage
event).

Run `pnpm --filter @linger/local-installation check` (`make check-packages`
runs it too); `make check-installer` runs its consumer, the installer, and
applies to changes that affect its public behavior.

## Local acceptance

Unit tests mock every process, so a change to install ordering, concurrency,
rollback, resume, or checkout switching also gets one real run on a
developer machine. Never touch the machine's own install (`~/.simplexai`,
`~/Library/Application Support/Linger`) or stop processes the run did not
start.

- Isolate everything a run writes. `LINGER_HOME` alone is not enough: the
  localmodels kit defaults to `~/.local/share/localmodels` and Pi to the one
  on `PATH`, so also set `HOME` to a scratch directory and
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, plus `LINGER_DESKTOP_USER_DATA` and
  `LINGER_BRIDGE_STATE_DIR` (otherwise the desktop removes the real bridge
  state). Use real paths: on macOS `/tmp` is a symlink and localmodels
  refuses it (`Unsafe runtime root`), so use `/private/tmp/...`.
- Run the desktop from source with `LINGER_CHECKOUT` naming the checkout under
  test (`apps/desktop/AGENTS.md`); add `--remote-debugging-port` to Electron to
  drive `app://setup/` over CDP. From source there are no bundled TeamHub
  binaries, so the installer prepares Go and compiles TeamHub, and its
  timings are not comparable with a packaged build.
- `LOCALMODELS_DEBUG=simulate:vram_gb=24` simulates the hardware, but a
  simulated local model echoes the prompt and fails `stack apply`'s answer
  check. Exercise a full install through BYOK instead, against the kit's
  stub endpoint once the installer has unpacked the kit:
  `PYTHONPATH=$K/modules $K/python/bin/python3.12 -P -s -m localmodels.debug_stub_server --bind 127.0.0.1 --port 18950 --model stub-model`
  with `K=$LINGER_HOME/tools/localmodels/<kit hash>`, then enter
  `http://127.0.0.1:18950/v1` and any key in setup. `--stop` leaves the
  simulated stub servers running; stop them yourself.
- Scenarios: a fresh install (runtime overlaps services and account in the
  job's stage timings); `--stop` then `--resume` on the same checkout (logs
  `Reusing the installed <runtime> runtime.` and overlaps); `--resume` while
  services run (returns `Services are already running.` with unchanged
  process IDs); and `--resume --source-repo` on another checkout (full
  `harness plan`/`apply`, migrations only after runtime preparation).
