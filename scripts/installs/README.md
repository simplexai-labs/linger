# Install scripts

This directory holds only the entry scripts of the local model stack, plus this
README. The upstream release tools generate scripts with pinned versions. Updates
are copied into a local checkout for review; opening a pull request, merging it
and releasing Linger are separate actions requested by the maintainer.

## Your own API keys: `user.env`

The Linger app keeps the keys you supply in `user.env` in its instance
folder, `~/.simplexai/instances/desktop/user.env` (`LINGER_HOME` replaces
`~/.simplexai`). The installer creates the file with comments on first start;
starting the services never changes it after that (the app's setup page
saves the keys typed there into it), and upgrades and reinstalls keep it. It
must stay private to you (`chmod 600`); otherwise the app stops and says how
to fix it. Docker Compose and `pnpm dev` read these keys from the root `.env`
instead.

| Name               | Turns on                                                |
| ------------------ | ------------------------------------------------------- |
| `COMPOSIO_API_KEY` | Connected apps such as Gmail, GitHub and Slack          |
| `SONIOX_API_KEY`   | Recording, dictation and meeting transcripts            |
| `XAI_API_KEY`      | Grok Live voice mode, without Soniox                    |
| `TZ`               | The services' time zone, for example `America/New_York` |

```sh
XAI_API_KEY=xai-...
SONIOX_API_KEY=...
```

Quit and reopen the Linger app after editing it: services whose configuration
changed restart, and LiveKit runs only while a voice key is set. Other names,
such as `LINGER_SECRET_SEED` or ports, are ignored with a warning, because the
installer manages them. Keys never appear in installer logs or the app's
diagnostics.

<!-- >>> llm-inference-lab: stack -->

## Local model stack: `stack.sh` / `stack.ps1`

`stack.sh` (Linux, macOS) and `stack.ps1` (Windows) run a pinned version of `localmodels stack`.
Both scripts hold only the version pin, no source: the first run downloads that version's
self-contained Python + localmodels kit for the platform from the CDN, checks the archive SHA256
pinned in the script and every file listed in the kit's `tool.json`, then caches it; later runs start
offline and need no system Python.

```sh
scripts/installs/stack.sh --help
scripts/installs/stack.sh capabilities --json
scripts/installs/stack.sh plan --offline
scripts/installs/stack.sh apply "/path/to/plan.json" --approve CONFIRMATION_ID
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\installs\stack.ps1 --help
```

Arguments pass unchanged to `localmodels stack`; with no arguments it shows the help. Where the CLI
hints say `python3 -m localmodels stack`, use `stack.sh` here. `apply` still needs the full
confirmation ID the plan prints; the scripts never plan or install on their own.

Environment variables:

- `LOCALMODELS_KIT_HOME`: kit cache directory, default `~/.cache/linger-localmodels/kits` (on Windows `%LOCALAPPDATA%\linger-localmodels\kits`).
- `LOCALMODELS_KIT_BASE_URL`: download the same files from an internal mirror; SHA256 is still checked against the pin in the script.

The Linger installer does not go through `stack.sh`; it calls the same kind of localmodels kit
directly and by convention pins the same version as here.

The same script also runs without cloning the repository: `curl -fsSL https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels/<version>/stack.sh | sh -s -- --help`.

For setup and supported runtime choices, see the
[Linger documentation](https://docs.heylinger.com/models/choose-a-runtime).

Maintainers generate these files from an explicitly published localmodels release
and apply the three generated files together to a local Linger checkout for review.
The updater preserves other README sections and does not create a branch, commit,
pull request or release. Submitting and merging the update and releasing Linger
require separate maintainer actions.
The version pin identifies the published CLI; it does not establish platform or
GPU support or real-device acceptance. Keep the scripts and this generated
section together when updating the pin.

<!-- <<< llm-inference-lab: stack -->
