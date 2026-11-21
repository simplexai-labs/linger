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
is canceled and replaced, so Try Again checks the computer again.
An idle desktop-owned manager steps aside when the desktop relaunches the same
instance with another checkout. Every installation runs natively from the
source checkout `--source-repo` names. Start failures print their real cause
on stderr for the desktop to show.
Native sign-in sessions belong to an instance and its selected runtime. A changed
setup choice must not reuse another runtime's URL or accept a code for its process;
starting sign-in for the new runtime stops the previous runtime's pending login.

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
program took the web port. A
local model stack whose saved binding is no longer ready (any setup binding
reason, `pi-extensions-unavailable` from a Pi an earlier localmodels
installed without extension support included) gets its approved plan applied
again when the saved plan inputs still match the current choices; only a
plan the person approved is ever applied, and a stack still not ready ends
`LOCAL_MODELS_RECOVERY_REQUIRED` with the binding's reason codes in
`details.reasons`. When the services already run, a local-models setup
whose Computer still uses the local model source (`model-source.json` says
`local` or does not exist yet) has its stack checked once
(`restoreLocalModels`), since a quit stops the models but not the services: a
stack that is not ready gets the same restore, then becomes the model source
again. A source switched to a subscription or BYOK leaves the stack stopped;
a saved BYOK source gets its Bifrost gateway mounted again from the saved
configuration unless it already answers (`restoreByokSource`), and a failure
is logged and reported in the ready outcome's `details.byokGateway`
without failing the resume; the Computer mounts it again before the next Run
on it.
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
the desktop's Computer follows them.

`--stop` (with `--instance`) is the desktop uninstall's and Windows setup's: it stops the
manager the desktop started for that instance (its `/api/stop` cancels a
running job) and the instance's services, deletes nothing, and prints one
JSON line with what failed. It needs nothing beside `installer.js`, so
setup can run it from a copy on an earlier release's `Linger.exe`. It also
stops what the pinned localmodels kit runs for each home: the model
library's loaded models, the model controller, and the stack with its
gateway (`stopLocalmodels`).

`--stop-local-models` is the desktop's quit: in the default home and the
location `desktop/local-server.json` names, it unloads the model library's
loaded models and stops the stack with the gateway the localmodels tool
started, and keeps the services and the model controller running. It
holds each home's local model lock (`withLocalModelsLock`) while it stops,
so the next launch's restore waits for it; a home whose lock a deployment
holds is skipped with a log line. A kit that is present but fails verification
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
