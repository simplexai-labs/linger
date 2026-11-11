# Install scripts

This directory holds only the entry scripts of the local model stack, plus this
README. Its release pipeline generates the scripts with pinned versions; source,
tests and release tools stay in their own repository, and the pipeline rewrites
only its scripts and its marked section below.

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
self-contained Python + localmodels kit from `@simplexai/localmodels-<target>` on npm, checks the archive SHA256
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

`--region auto|global|cn` before the command selects the registry (`-Region` in PowerShell).
The flag overrides `SIMPLEX_REGION`, which defaults to `auto`. Auto probes the first 256 KiB of
the pinned tarball from both registries in parallel with a five second deadline. It chooses the
faster success and defaults to global if both fail. A download error retries the other registry
once. A SHA256 mismatch is fatal. The resolved region is passed to localmodels and its Bifrost
downloader through `SIMPLEX_REGION`; a resolved parent value does not probe again.
An untouched `auto` on a cached launch stays `auto`, so a later Bifrost download probes its own tarball.
Redirects stay on HTTPS and are limited to five hops.

Other arguments pass unchanged to `localmodels stack`; with no arguments it shows the help. Where the CLI
hints say `python3 -m localmodels stack`, use `stack.sh` here. `apply` still needs the full
confirmation ID the plan prints; the scripts never plan or install on their own.

Environment variables:

- `LOCALMODELS_KIT_HOME`: kit cache directory, default `~/.cache/simplex-localmodels/kits` (on Windows `%LOCALAPPDATA%\simplex-localmodels\kits`).
- `SIMPLEX_NPM_REGISTRY`: replace both registry bases with a test registry or private mirror. Archive SHA256 and size pins still apply.
- `SIMPLEX_REGION`: `global` uses `registry.npmjs.org`; `cn` uses `registry.npmmirror.com`; `auto` probes both.
- `LOCALMODELS_KIT_BASE_URL`: legacy mirror layout serving the same pinned npm archives as `<target>.tgz`.

The Linger installer does not go through `stack.sh`; it calls the same kind of localmodels kit
directly and by convention pins the same version as here.

Run the pinned script without cloning the repository:

```sh
# global
curl -fsSL https://cdn.jsdelivr.net/npm/@simplexai/localmodels@0.1.0-dev.31/stack.sh | sh -s -- --region global --help
# cn
curl -fsSL https://registry.npmmirror.com/@simplexai/localmodels/0.1.0-dev.31/files/stack.sh | sh -s -- --region cn --help
```

```powershell
irm https://cdn.jsdelivr.net/npm/@simplexai/localmodels@0.1.0-dev.31/stack.ps1 -OutFile stack.ps1
powershell -ExecutionPolicy Bypass -File .\stack.ps1 -Region global --help
# cn script URL: https://registry.npmmirror.com/@simplexai/localmodels/0.1.0-dev.31/files/stack.ps1
```

The localmodels release process publishes each version's platform kits, its patched Bifrost packages and the
platform-independent `@simplexai/localmodels` package holding both scripts and `release.json`. `stack.sh`, `stack.ps1`
and this section carry that release's pin; do not edit them by hand. The version pin only says which published CLI
runs; it does not state which platforms or GPUs are supported.

<!-- <<< llm-inference-lab: stack -->
