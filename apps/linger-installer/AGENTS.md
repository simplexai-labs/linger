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
An idle desktop-owned manager steps aside when the desktop relaunches the same
instance with another checkout. Every installation runs natively from the
source checkout `--source-repo` names. Start failures print their real cause
on stderr for the desktop to show.

`--resume` (native source with `--instance`) starts an installed instance's
stopped services headless, reusing its saved choices; the desktop client runs it
after a reboot and reads the outcome from the single JSON line on stdout. It
also restarts running services when the instance's `user.env` no longer
matches the configuration they started with. With `--external-computer`, a
successful outcome carries `runtime`, the same instance runtime as
`GET /api/instances/{name}/runtime` (runtime and localmodels tool paths), so
the desktop's Computer follows them.

`--stop` (with `--instance`) is the desktop uninstall's and Windows setup's: it stops the
manager the desktop started for that instance (its `/api/stop` cancels a
running job) and the instance's services, deletes nothing, and prints one
JSON line with what failed. It needs nothing beside `installer.js`, so
setup can run it from a copy on an earlier release's `Linger.exe`.

Every other mode first converts an install from before the rename to Linger
(`migrateLegacyInstallation`); `--migrate` does only that and exits, for the
desktop client.

Run `make check-installer`; verify UI process behavior with an isolated
browser context and retain masked evidence. Never stop a user's existing stack
or global Computer to run acceptance.
