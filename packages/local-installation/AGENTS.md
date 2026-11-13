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

Local model recovery messages summarize only known failed or skipped components
and allowlisted guard codes from the upstream JSONL protocol. Native component
details and exception text stay private; they are not copied into public
installation events. An operation failure does not imply hardware ineligibility.

Each instance directory holds `user.env` (0600), the only file a person edits:
`COMPOSIO_API_KEY`, `SONIOX_API_KEY`, `XAI_API_KEY` and `TZ`
(`user-environment.ts`). Every mode merges it into the generated
`compose.env` / `native.env` over a developer checkout's `.env` and under the
installer's own values; other names are ignored with a warning, and the file
is created from a template once and never rewritten. The desktop source
package's `.env` is not read. Voice keys are normally saved in the app
(TeamHub); a key in `user.env` overrides it. Whenever the distribution has
voice tools for this computer, Native prepares them and runs LiveKit with
the key pair and ports in the instance's `livekit.env`, with or without a
voice key; without them, or when they fail to prepare, TeamHub gets
`TEAMHUB_VOICE_MEDIA=off` and the install continues. The services' `voice`
setting tracks only the tools, so a key change never restarts them through
it. A native process restarts when its generated environment changes.
Every update or recreate path stops node-services on its own, right before
TeamHub restarts (natively: for a changed configuration) and while TeamHub is
still up, so its graceful shutdown requeues in-flight Agent Runs.

The home is `LINGER_HOME`, else `~/.simplexai` (`home.ts`). Installs from
before the product was renamed Linger convert once in
`legacy-migration.ts`, which the installer runs before it opens the home and
the desktop runs through `installer.js --migrate`. Under each instance's lock
it stops the instance's Computer and native services, renames `SIMPLEX_*`
keys in the generated env files, and gives the instance its
`linger-<name>-<hash>` project name. The legacy project name in
`instance.json` marks an instance as not yet converted, so it is written last
and a rerun after a crash converges. A damaged record is skipped, and a
failing instance does not stop the others; the migration then throws one
error naming each failed instance, and the installer does not start. The
cache markers `.simplex-files.json` and `.simplex-model-package.json` keep
their names.

Move a freshly downloaded or unpacked file or folder into place with
`renameRetrying` from `fs-retry.ts`: on Windows antivirus and indexing hold
new files for a moment, and a plain rename then fails with EPERM.

Run `pnpm --filter @linger/local-installation check`; `make check-installer`
also runs its consumer, the installer, and applies to changes that affect its
public behavior.
