# Install scripts

This directory holds only the entry scripts of the local model stack, plus this
README. Its release pipeline generates the scripts with pinned versions; source,
tests and release tools stay in their own repository, and the pipeline rewrites
only its scripts and its marked section below. After updating `stack.sh` and
`stack.ps1`, run `node scripts/sync-install-stack-pin.mjs --write` so
`scripts/install/install.sh` and `scripts/install/install.ps1` keep matching
release pins for standalone use outside a repository checkout (Desktop GitHub
Releases do not attach those scripts).

## Your own API keys: `user.env`

The Linger app keeps the keys you supply in `user.env` in its instance
folder, `~/.simplexai/instances/desktop/user.env` (`LINGER_HOME` replaces
`~/.simplexai`). The installer creates the file with comments on first start;
starting the services never changes it after that (the app's setup page
saves the keys typed there into it), and upgrades and reinstalls keep it. It
must stay private to you (`chmod 600`); otherwise the app stops and says how
to fix it. Docker Compose and `pnpm dev` read these keys from the root `.env`
instead.

| Name               | Turns on                                                     |
| ------------------ | ------------------------------------------------------------ |
| `COMPOSIO_API_KEY` | Connected apps such as Gmail, GitHub and Slack               |
| `SONIOX_API_KEY`   | Recording, dictation and meeting transcripts (overrides app) |
| `XAI_API_KEY`      | Grok Live voice mode, without Soniox (overrides app)         |
| `TZ`               | The services' time zone, for example `America/New_York`      |

Voice keys are normally saved in the app itself; a voice key written here
still works and takes precedence over the one saved in the app.

```sh
XAI_API_KEY=xai-...
SONIOX_API_KEY=...
```

Quit and reopen the Linger app after editing it: services whose configuration
changed restart. LiveKit runs whenever the app has voice tools for this
computer, with or without a voice key. Other names,
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
- `SIMPLEX_IMAGE_MIRROR`: used by the Simplex container installer for its cn image registry. It does not change localmodels kit or Bifrost downloads.
- `LOCALMODELS_KIT_BASE_URL`: legacy mirror layout serving the same pinned npm archives as `<target>.tgz`.

The Simplex installer does not go through `stack.sh`; it calls the same kind of localmodels kit
directly and by convention pins the same version as here.

Run the pinned script without cloning the repository:

```sh
# global
curl -fsSL https://cdn.jsdelivr.net/npm/@simplexai/localmodels@0.1.0-dev.59/stack.sh | sh -s -- --region global --help
# cn
curl -fsSL https://registry.npmmirror.com/@simplexai/localmodels/0.1.0-dev.59/files/stack.sh | sh -s -- --region cn --help
```

```powershell
irm https://cdn.jsdelivr.net/npm/@simplexai/localmodels@0.1.0-dev.59/stack.ps1 -OutFile stack.ps1
powershell -ExecutionPolicy Bypass -File .\stack.ps1 -Region global --help
# cn script URL: https://registry.npmmirror.com/@simplexai/localmodels/0.1.0-dev.59/files/stack.ps1
```

Source, templates and tests live in `localmodels/` and `scripts/installs/` of llm-inference-lab.
Each localmodels release publishes the platform kits, patched Bifrost packages and the platform-independent
`@simplexai/localmodels` package containing both scripts and `release.json`.
To adopt a release, manually copy its generated `stack.sh`, `stack.ps1` and this section into the
consumer repository, preserving the other install scripts and README sections. Keep the generated files unchanged.
The version pin only says which published CLI runs; platform and GPU support and real-device acceptance status are set by
llm-inference-lab's product documents and dated reports.

<!-- <<< llm-inference-lab: stack -->

## Download region: `SIMPLEX_REGION`, `SIMPLEX_REGION_FILE`, and `region.json`

Linger, the Computer Daemon, and `localmodels` share one download region and
per-ecosystem speed profile (`<LINGER_HOME>/runtime/region.json`, passed via
`SIMPLEX_REGION_FILE`), so every download selects the fastest measured global
or mainland-China mirror without waiting on throttled hosts. See
[Network Download Optimization Strategy](../../docs/network-download-optimization.md)
for the complete specification. The region only orders candidate sources: no
source is ever dropped, and pinned SHA-256, SHA-512, or lockfile digests still
decide which bytes are accepted.

The installer resolves the region once per process, in this order:

1. `SIMPLEX_REGION`: `cn` or `global` forces that region; `auto` or unset
   does not. Any other value is an error.
2. `<LINGER_HOME>/runtime/region.json` when it was resolved within the last
   6 hours and its `network_fingerprint` matches the current proxy environment.
3. A concurrent multi-signal probe racing npm (`registry.npmjs.org` vs
   `cdn.npmmirror.com`) and PyPI (`pypi.org` vs Tsinghua / Aliyun / USTC /
   Tencent mirrors) so Cloudflare Anycast on npm alone cannot falsely lock a
   China host onto slow PyPI or model downloads. A probe that reaches neither
   uses `global` and is not saved.

```json
{
  "schema": "simplex.region/v1",
  "region": "cn",
  "resolved_at": "2026-11-24T08:00:00.000Z",
  "method": "probe",
  "network_fingerprint": "direct",
  "ecosystems": {
    "pypi": {
      "region": "cn",
      "name": "pypi-tsinghua",
      "url": "https://pypi.tuna.tsinghua.edu.cn/simple/",
      "bytes_per_second": 880000,
      "candidates": [
        "https://pypi.tuna.tsinghua.edu.cn/simple/",
        "https://mirrors.aliyun.com/pypi/simple/"
      ],
      "measured_at": "2026-11-24T08:00:00.000Z",
      "method": "probe"
    }
  }
}
```

`method` is `env`, `probe` or `fallback`. When the preferred region fails or
downloads slowly with substantial work left and a source in the other region
proves faster and finishes the download, the file is rewritten with that
region and `fallback`, and later downloads start there (unless
`SIMPLEX_REGION` forces a region).

| Download                             | global first                               | cn first (speed-ranked where multiple exist)                          |
| ------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------- |
| Node.js runtime (desktop app)        | `nodejs.org`                               | `cdn.npmmirror.com`, `mirrors.tuna.tsinghua.edu.cn/nodejs-release`    |
| pnpm, npm and package installs       | `registry.npmjs.org`                       | `registry.npmmirror.com`                                              |
| Go toolchain                         | `dl.google.com`                            | `mirrors.aliyun.com/golang`                                           |
| Go modules (`GOPROXY`, unless set)   | `proxy.golang.org`                         | `goproxy.cn`, `goproxy.io`                                            |
| PyPI indexes & engine wheels         | `pypi.org`, `files.pythonhosted.org`       | Tsinghua (`pypi.tuna.tsinghua.edu.cn`), Aliyun, USTC, Tencent, Huawei |
| Rust / Homebrew (Agent runs)         | `static.rust-lang.org`, `formulae.brew.sh` | Tsinghua, USTC                                                        |
| Model hubs                           | `huggingface.co`                           | `modelscope.cn`, `hf-mirror.com`                                      |
| localmodels kit                      | CloudFront, then npm                       | `cdn.npmmirror.com` where it has the kit                              |
| Voice model packages (node-services) | `registry.npmjs.org`                       | `registry.npmmirror.com`                                              |

A registry, index, or `GOPROXY` the person configured still wins. The installer
and Computer Daemon pass `SIMPLEX_REGION` and `SIMPLEX_REGION_FILE` to every
`localmodels` child and inject cached per-ecosystem language mirrors into Agent
Runs with zero network round trips.
