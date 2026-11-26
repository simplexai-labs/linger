# Network Download Optimization Strategy

This document specifies how Linger, the Local Computer Daemon, the standalone
install scripts, and `localmodels` dynamically choose between global and
mainland-China acceleration sources based on real speed measurements across
model hubs and language/toolchain package ecosystems.

## Goals and Security Invariants

1. **Speed-driven selection, never dropping fallbacks**: Probing and region
   state only reorder candidate sources. No candidate is deleted, and every
   download automatically fails over and resumes from the next candidate on
   errors, slow transfers, or checksum mismatches.
2. **Cryptographic integrity stays the sole trust root**: Mirrors serve bytes
   only. Every installer artifact, runtime archive, Go/Node/PostgreSQL binary,
   engine wheel, and model weight is still verified against pinned SHA-256,
   SHA-512, or lockfile digests. Unpinned Hugging Face hashes are never minted
   from mirrors.
3. **User configuration always wins**: Any mirror or index explicitly set by
   the user via environment variables (`PIP_INDEX_URL`, `UV_DEFAULT_INDEX`,
   `UV_INDEX_URL`, `UV_INDEX`, `npm_config_registry`, `pnpm_config_registry`,
   `GOPROXY`, `RUSTUP_DIST_SERVER`, `RUSTUP_UPDATE_ROOT`, `HF_ENDPOINT`,
   `HOMEBREW_API_DOMAIN`, `HOMEBREW_BOTTLE_DOMAIN`) or config files (`pip.conf`,
   `pip.ini`, `uv.toml`, `.npmrc`, including `NPM_CONFIG_USERCONFIG` and
   workspace-local configs) is preserved untouched.
4. **Zero added latency on the Agent Run critical path**: The Computer Daemon
   reads only the local cached `region.json` when preparing an Agent Run
   environment (no network round trips before `provider_ready`).
5. **No secrets, symlinks, or untrusted URLs**: `region.json` stores only an
   opaque SHA-256 prefix (`network_fingerprint`) derived from proxy environment
   variables, never raw proxy URLs or credentials. All readers reject symlinked
   `region.json` files and validate persisted ecosystem URLs against the
   built-in HTTPS mirror allowlist before injecting any environment variables.

## Shared Profile: `<LINGER_HOME>/runtime/region.json` (`simplex.region/v1`)

Linger (`packages/local-installation`), Desktop (`apps/desktop`), Computer
Daemon (`apps/computer/local-daemon`), and `localmodels` share one
`region.json` file via `SIMPLEX_REGION_FILE`:

```json
{
  "schema": "simplex.region/v1",
  "region": "cn",
  "resolved_at": "2026-11-24T12:00:00.000Z",
  "method": "probe",
  "network_fingerprint": "direct",
  "ecosystems": {
    "npm": {
      "region": "cn",
      "name": "npm-npmmirror",
      "url": "https://registry.npmmirror.com",
      "bytes_per_second": 4200000,
      "candidates": [
        "https://registry.npmmirror.com",
        "https://registry.npmjs.org"
      ],
      "measured_at": "2026-11-24T12:00:00.000Z",
      "method": "probe"
    },
    "pypi": {
      "region": "cn",
      "name": "pypi-tsinghua",
      "url": "https://pypi.tuna.tsinghua.edu.cn/simple/",
      "bytes_per_second": 880000,
      "candidates": [
        "https://pypi.tuna.tsinghua.edu.cn/simple/",
        "https://mirrors.aliyun.com/pypi/simple/",
        "https://pypi.mirrors.ustc.edu.cn/simple/"
      ],
      "measured_at": "2026-11-24T12:00:00.000Z",
      "method": "probe"
    }
  }
}
```

### Freshness, Proxy Fingerprinting, and Multi-Signal Probing

1. **Precedence**:
   - Explicit `SIMPLEX_REGION` (`cn` or `global`; `auto` or unset defers to
     cache/probe).
   - Cached `<LINGER_HOME>/runtime/region.json` when younger than **6 hours**
     (`REGION_STALE_MS` / `mirrors.MaxAge` / `STALE_AFTER`) **and** its
     `network_fingerprint` matches the current proxy environment.
   - Concurrent multi-signal speed probe.
2. **Cross-language `network_fingerprint`**:
   - Python (`localmodels/mirrors.py`), TypeScript (`mirror-probe.ts`), and Go
     (`internal/mirrors/mirrors.go`) compute the exact same fingerprint over
     `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`
     (case-insensitive, deduplicated, sorted, joined by `\n`): `"direct"` when
     empty, otherwise `"proxy:" + sha256_hex[:16]`.
   - Enabling, disabling, or changing a VPN/proxy immediately invalidates stale
     cached decisions.
3. **Multi-signal region resolution**:
   - `resolveRegion` concurrently races npm (`probeNpmRegistries`, up to 1 MiB
     tarball transfer per round), PyPI (`probeEcosystem("pypi")`, 128 KiB), and
     the remaining language/model ecosystems (`node` 128 KiB, `go` 16 KiB,
     `rust` 128 KiB, `model_hub` 64 KiB, and `homebrew` 128 KiB on macOS) in a
     single parallel batch.
   - Because npm uses Cloudflare Anycast nodes that can sometimes answer fast
     from mainland China while PyPI and Hugging Face remain severely throttled,
     a decisive China win on PyPI (`>= 1.5x` throughput ratio) prevents a false
     `global` classification.
   - Each answering ecosystem's speed-ranked candidates are saved under
     `ecosystems` so downloads and Agent Runs pick the fastest specific mirror
     (for example, Tsinghua over Aliyun or npmmirror when Tsinghua measures
     faster on the user's ISP).

## Covered Ecosystems and Mirror Pools

| Ecosystem                        | Consumers                                                                                | Global candidates                                      | Mainland-China candidates                                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PyPI (Simple index & wheels)** | `localmodels` engine wheels (e.g. CUDA cuBLAS), `pip`/`uv` venvs, Agent Python runs      | `pypi.org/simple/`, `files.pythonhosted.org/packages/` | Simple index: `pypi.tuna.tsinghua.edu.cn`, `mirrors.aliyun.com/pypi`, `pypi.mirrors.ustc.edu.cn`, `mirrors.cloud.tencent.com/pypi` (wheel expansion also adds `repo.huaweicloud.com/repository/pypi/packages/`) |
| **Model hubs**                   | `localmodels` GGUF/SafeTensors/projector weights, Agent `HF_ENDPOINT`                    | `huggingface.co`                                       | `modelscope.cn`, `hf-mirror.com`                                                                                                                                                                                |
| **npm / pnpm**                   | Installer tool downloads, voice packages, Agent JS/TS runs, `install.sh` / `install.ps1` | `registry.npmjs.org`                                   | `registry.npmmirror.com` (`cdn.npmmirror.com`)                                                                                                                                                                  |
| **Node.js releases**             | Desktop and local-computer Node runtime downloads                                        | `nodejs.org/dist/`                                     | `cdn.npmmirror.com/binaries/node/`, `mirrors.tuna.tsinghua.edu.cn/nodejs-release/`                                                                                                                              |
| **Go toolchain & modules**       | Native source builds and Agent Go runs                                                   | `dl.google.com/go/`, `proxy.golang.org`                | `mirrors.aliyun.com/golang/` (direct archive without 302 redirect), `goproxy.cn`, `goproxy.io` (pipe-delimited `GOPROXY` for 5xx/timeout failover)                                                              |
| **Rust / rustup**                | Agent Rust/Cargo toolchain downloads                                                     | `static.rust-lang.org`                                 | `mirrors.tuna.tsinghua.edu.cn/rustup`, `mirrors.ustc.edu.cn/rust-static`                                                                                                                                        |
| **Homebrew (macOS)**             | Agent macOS CLI installs                                                                 | `formulae.brew.sh/api`                                 | `mirrors.tuna.tsinghua.edu.cn/homebrew-bottles`, `mirrors.ustc.edu.cn/homebrew-bottles`                                                                                                                         |

## End-to-End Handoff Across Components

1. **Standalone install scripts (`scripts/install/install.sh` & `install.ps1`)**:
   - When `SIMPLEX_REGION=auto` (default), concurrently race the first 256 KiB
     of `@simplexai/localmodels` from `registry.npmjs.org` and
     `registry.npmmirror.com` (4 s timeout), trying the faster responder first
     and keeping the other as fallback.
2. **Installer & Desktop (`packages/local-installation` & `apps/desktop`)**:
   - `downloadInRegion` applies both region ordering and any cached
     per-ecosystem candidate ranking (such as Tsinghua vs npmmirror for Node.js),
     switching and resuming on slow transfers or failures via `downloadVerified`.
   - `runLocalmodelsCommand` passes both `SIMPLEX_REGION` and
     `SIMPLEX_REGION_FILE=<home>/runtime/region.json` to `localmodels`.
   - Desktop's `daemonEnvironment` inherits the user's `SIMPLEX_REGION` and
     overlays absolute runtime paths (including `LINGER_LOCALMODELS_STATE_DIR`)
     when spawning the Go Computer Daemon.
3. **Computer Daemon (`apps/computer/local-daemon`)**:
   - `internal/localmodels/tool.go` uses `internal/mirrors.LocalmodelsEnv` to
     pass `SIMPLEX_REGION_FILE` (derived from `StateDirectory` as
     `<home>/runtime/region.json`) and any fresh cached `SIMPLEX_REGION`
     (`<= 6 h`) to every `localmodels` invocation (`library download`, `source apply`,
     etc.); when `region.json` is stale, `SIMPLEX_REGION` is omitted so
     `localmodels` refreshes the shared file.
   - `internal/linger/context/resolver.go` calls
     `internal/mirrors.ApplyAgentEnvironmentInDir` using the cached
     `region.json` (zero network RTT) so Agent Runs automatically accelerate
     `pip`, `uv`, `npm`, `pnpm`, `go`, `rustup`, `huggingface-cli`, and macOS
     `brew` without overriding user settings or user config files. As a
     read-only hot-path consumer, it keeps using a stale profile past 6 hours as
     long as `network_fingerprint` still matches, and drops it immediately when
     proxy settings change.
4. **`localmodels` downloads**:
   - Uses tiered concurrent speed probing with a cross-region escape hatch
     (probing the opposite side whenever the preferred side is unreachable or
     below 2.0 MB/s), mid-transfer slow-host switching (`< 256 KiB/s` over 15 s
     with `> 30 s` remaining) with HTTP Range resume, automatic
     `region_fallback` persistence back into the shared `region.json`, and live
     progress reporting during engine archive downloads.

## Verification Coverage

- **`packages/service-kit/src/index.test.ts`**: China mirror domain
  classification across Tsinghua, USTC, Tencent, Huawei, `golang.google.cn`,
  `goproxy.io`, `hf-mirror.com`, `modelscope.cn`, and spoofed-domain rejection.
- **`packages/local-installation/src/mirror-probe.test.ts`**: 7-ecosystem
  catalog, concurrent PyPI speed ranking (Tsinghua > Aliyun > official),
  multi-signal `resolveRegion` breaking Cloudflare Anycast npm false-global and
  populating all ecosystems, proxy fingerprint parity & invalidation, and
  per-ecosystem download ordering.
- **`packages/local-installation/src/region.test.ts`**: 6-hour TTL, shared
  probe cancellation semantics, slow-transfer mirror switch, and fallback
  persistence.
- **`packages/local-installation/src/localmodels-tool.test.ts`**:
  `SIMPLEX_REGION` and `SIMPLEX_REGION_FILE` handoff to `localmodels`.
- **`apps/computer/local-daemon/internal/mirrors/mirrors_test.go`**,
  **`internal/localmodels/tool_test.go`**, and
  **`internal/linger/context/resolver_mirrors_test.go`**: Shared `region.json`
  handoff to `localmodels`, stale-profile retention vs proxy-change
  invalidation, zero-RTT Agent Run mirror injection across ecosystems, and
  preservation of user env vars and `pip.conf` / `uv.toml` / `.npmrc`.
