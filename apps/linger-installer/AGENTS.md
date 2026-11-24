# Independent local installer

This app owns the loopback installation manager and its browser UI. It starts
without Docker or product services and calls the shared local-installation
package. Do not import other apps' source or add product business ownership.

Consume generated linger-installer contract types; edit OpenAPI source first.
Keep bootstrap/control/session capabilities out of argv, logs and screenshots.
Only the authorized no-store login endpoint and explicit credentials view may
show the user's password; redact events, diagnostics and persisted job snapshots.
Browser closure never cancels installation. Repeated launches reuse the manager,
instance mutations remain locked, and cancellation retains account/data/device.
Native sign-in cancellation and manager shutdown invalidate pending runtime
inspections before they can launch a login process; a newer explicit start owns
the instance's pending inspection.
A queued job is busy while its initial private files are being saved. Canceling
it prevents execution after those writes, and shutdown drains that initial save
before returning, just as it waits for an executing job. An initial input-save
failure is reported by start without interrupting shutdown's remaining cleanup;
storage failures for retained jobs still propagate.
A closed native sign-in input reports failure without stopping the installer;
retry starts a new owned login process.
A start returns the instance's running or queued job; a job that finished its
run and waits for the person (`waiting_user`, e.g. `LOCAL_MODELS_UNAVAILABLE`)
is canceled and replaced, so Try Again checks the computer again. A start that
names another choice (`setupChoice`, or BYOK for another runtime) than the
active job's is the person's latest choice: it cancels that job (stopping a
local model download chosen before, which the manager keeps running after the
desktop quits) and runs once it has ended. The start answers at once with the
new `queued` job: the earlier job may be in a step that only stops at its end
(services, account, computer), which can take minutes, so the new job waits for
it in the background and shutdown or a cancel stops it before it runs. A start
without a choice follows the active job.
An idle desktop-owned manager steps aside when the desktop relaunches the same
instance with another checkout. Every installation runs natively from the
source checkout `--source-repo` names. Start failures print their real cause
on stderr for the desktop to show.
Native sign-in sessions belong to an instance and its selected runtime. A changed
setup choice must not reuse another runtime's URL or accept a code for its process;
starting sign-in for the new runtime stops the previous runtime's pending login.
A Codex start may name its login method: `browser` (localhost callback; on
Linux it runs with `BROWSER=true` so only the caller opens the link, elsewhere
the CLI opens its own page) or `device` (device code).
Without one, macOS and Windows use the browser login, which opens its own
page, and other platforms the device code. A start with another method replaces
the running login. A failed login carries its `reason`; a timeout stays
`timed_out` after the process exits.

`--resume` (native source with `--instance`) starts an installed instance's
stopped services headless, reusing its saved choices; the desktop client runs it
after a reboot and reads the outcome from the single JSON line on stdout. Cold
resumes on the same checkout pass `resume: true` (a resume onto another
checkout omits it and prepares the runtime in full, sequentially) so an already-installed runtime
is reused after one status check, runtime/foundation preparation overlaps
service startup, and inspected runtime descriptors are passed directly to
`instanceRuntime` without a second status probe. It also restarts running
services when the instance's `user.env` no longer
matches the configuration they started with, or when `--source-repo` names
another checkout than the instance's. An instance follows a new checkout only
once its services are ready on it: until then `instance.json` keeps naming the
checkout they run from, the new checkout's migrations run only after the
runtime (the local model, for one) is ready, and a run that stops earlier
leaves the running services and their schema as they were. A successful
outcome's `details.source` names the checkout the services serve from, and
`details.origin` the origin they serve at, which the run moves when another
program took the web port. A local model stack whose saved binding is no longer ready and whose saved plan
inputs still match starts in place with `stack up` first when the binding
reports a stopped deployment or gateway (`deployment-unavailable` or
`gateway-unavailable`), so upgrades across `localmodels` kits or retired
catalog models keep the installed stack running without re-planning; it falls
back to applying the approved plan again when `stack up` fails or another
binding reason (such as `pi-extensions-unavailable` from a Pi an earlier
localmodels installed without extension support) remains. Only a plan the
person approved is ever applied, and a stack still not ready ends
`LOCAL_MODELS_RECOVERY_REQUIRED` with the binding's reason codes in
`details.reasons` (exposed on jobs as `errorReasons`) and any upstream stack
guard or plan error code in `details.causeCode` (exposed on jobs as
`errorCauseCode`). When the services already run, a setup whose
Computer uses the local model source (`model-source.json` says `local`, or does
not exist yet on a `local-models` setup) has its stack and saved library model
checked (`restoreLocalModels`), since a quit stops the models but not the
services: a stack that is not ready gets the same restore, an unloaded saved
local model (`localmodels/` or `localmodels-library/`) is reloaded, and the local source is applied again;
if that restore fails or throws (or a cold resume, including the first start after an app update onto a
new checkout, cannot prepare the local model stack or reload its saved library
model), the failure is logged
and reported in the ready outcome's `details.localModelsDegraded` without
failing the resume, so the person can still reach the workspace and the Models
page. Resource-choice mismatches omit stale binding reason codes so Quick
Install still triggers a replan. Both same-version resume (`restoreLocalModels`)
and version upgrades from the saved setup choice leave the stack stopped when
`model-source.json` was switched to `subscription` or `byok`; a saved BYOK
source gets its Bifrost gateway mounted again from the saved configuration
unless it already answers (`restoreByokSource`), and a failure is logged and
reported in the ready outcome's `details.byokGateway` without failing the
resume; the Computer mounts it again before the next Run on it.
A failed installation records the stage that caused it, even when native
checkout preparation and runtime setup ran in parallel. A BYOK mount failure
belongs to runtime and keeps the redacted provider error in the job.
A failed job's `errorCode` is the runtime's cause when it
has one (`RUNTIME_PLAN_REFUSED`, a harness plan refused before anything
changed, such as an unusable `SIMPLEX_PI_PATH` or a Windows runtime root too
long for Pi without long paths; `RUNTIME_ACTION_FAILED`;
`RUNTIME_EXTENSIONS_FAILED`), otherwise `INSTALL_FAILED`. With
`--external-computer`, a successful outcome carries `runtime`, the same instance runtime as
`GET /api/instances/{name}/runtime` (runtime and localmodels tool paths), so
the desktop's Computer follows them. The HTTP lookup writes one JSON line to
stderr, `{"event":"installer.runtime_lookup_timings","instance",...,"timings"}`,
whose `timings` holds `config`, `runtime`, `localModels`, `tool` and `total`
in ms; the `--resume` outcome carries the same object as
`runtimeLookupTimings` whenever the lookup ran. The desktop logs both at info
as `local_server.installer_runtime_timings`, keyed on that event name and
field shape, which are its contract. The route's response body does not carry
these timings.

A desktop-owned install uses the selected runtime descriptor to return the
paths on its live completed job and emits the same timings event. Listing jobs
and reloading saved jobs omit the runtime so a later setup reads current paths.
When the handoff fails, the job still succeeds without `runtime`, stderr gets
one `{"event":"installer.runtime_handoff_failed","instance","message"}` line,
and the desktop falls back to `GET /api/instances/{name}/runtime`.

`GET /api/instances/{name}/runtime` runs one lookup per instance at a time
(`runtime-lookup.ts`): a second request joins the running one, and a finished
answer is kept for 10 minutes, so a desktop that stopped waiting picks up the
late result on Try Again or its next launch instead of starting the lookup
over. Starting or finishing an install, or saving a runtime key, forgets it.
The runtime descriptors an install inspected answer the lookup in place of a
second status probe, as on the resume path.

`--stop` (with `--instance`) is the desktop uninstall's and Windows setup's: it stops the
manager the desktop started for that instance (its `/api/stop` cancels a
running job) and the instance's services, deletes nothing, and prints one
JSON line with what failed. It needs nothing beside `installer.js`, so
setup can run it from a copy on an earlier release's `Linger.exe`. It also
stops what the pinned localmodels kit runs for each home: the model
library's running loads (cancelled) and loaded models, the model controller, and the stack with its
gateway (`stopLocalmodels`).

`--stop-local-models` is the desktop's quit: in the default home and the
location `desktop/local-server.json` names, it cancels the model library's
running loads, unloads its loaded models and stops the stack with the gateway the localmodels tool
started, and keeps the services and the model controller running. It
holds each home's local model lock (`withLocalModelsLock`) while it stops,
so the next launch's restore waits for it; a home whose lock a deployment
holds is skipped with a log line. Taking the lock retries a busy lock for up
to 2 s, because the Computer Daemon probes it for a moment after it starts. A kit that is present but fails verification
is a stop failure, so the helper logs the repair guidance, prints a JSON
failure and exits nonzero without running or downloading that tool. This
helper is detached: Linger quits and its log records that the models may
still be running. The full `--stop` command reports the same failure. Windows
uninstall aborts on that failure; replacement setup reports it and proceeds.
A missing pinned kit has nothing to stop.

`--inspect` checks without migrating installations. Its optional
`--inspect-target` selects the home whose disk and runtimes are checked;
`--home` still owns the inspection tool cache and state.

Every other mode first converts an install from before the rename to Linger
(`migrateLegacyInstallation`); `--migrate` does only that and exits, for the
desktop client. An instance it could not convert never stops the
installer, and the next start tries again. Only `--migrate` reports them: a
warning naming each and why on stderr, and one JSON line
`{"skipped":[{instance,reason}]}` on stdout. Other modes stay silent, so a
warning is never taken for the reason a start failed, and refuse a skipped
instance when they open it. Fresh native installs overlap `migrate`,
`services`, and `account` with `runtime` while holding `services`/`account`
completion until both branches succeed; upgrades and live re-runs keep `migrate`
sequential after `runtime`.

Run `make check-installer`; verify UI process behavior with an isolated
browser context and retain masked evidence. Never stop a user's existing stack
or global Computer to run acceptance.
