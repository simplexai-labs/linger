# Desktop Release

Linger desktop releases are published in the public
[simplexai-labs/linger](https://github.com/simplexai-labs/linger) repository:
pushing a `desktop-v<version>` tag there runs GitHub Actions
([`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)),
which builds the packages for Apple silicon, Linux x64 and Windows x64 and
publishes them as the GitHub Release of that tag. The workflow calls
[`scripts/ci/desktop-release.sh`](../scripts/ci/desktop-release.sh), so the
same steps also run on a developer machine.

This is the only release path.

## Downloads

The newest stable packages are always at
<https://github.com/simplexai-labs/linger/releases/latest>; a prerelease never
becomes the latest release. Link there, not to a version.

## Releasing

In a checkout of simplexai-labs/linger:

```sh
git tag desktop-v0.16.36
git push origin desktop-v0.16.36
```

- The tag is `desktop-v<major>.<minor>.<patch>`, optionally with a suffix such
  as `-rc.1`, beside the `cli-v<version>` tags of the CLI. A version with a
  hyphen is published as a GitHub prerelease whose notes start with
  **Prerelease**; a stable version is marked as the latest release.
- The version comes from the tag. The build writes it into
  `apps/desktop/package.json` for packaging and restores the file afterwards, so
  no version commit is needed.
- The release appears under the repository's Releases with the files listed in
  [Release Files](#release-files).

## How the workflow runs

The workflow runs for `desktop-v*` tags and from Actions → Desktop release →
Run workflow. Its `build` jobs
run on `ubuntu-24.04` (the macOS and Windows runners have no Docker) and keep
the files as workflow artifacts for 14 days; `release` writes `SHA256SUMS.txt`
and creates the GitHub Release, or uploads the files again to an existing one.
A manual run publishes only with `publish` set.

The release goes to `RELEASE_REPO`, `simplexai-labs/linger` by default:

- **In simplexai-labs/linger itself**, the workflow's `GITHUB_TOKEN`
  publishes; no extra secret is needed. The tag is the one pushed, at the
  built commit.
- **In another repository**, such as a private copy, it publishes
  across repositories with the `LINGER_RELEASE_TOKEN` secret; `prepare` stops
  at once when that secret is missing. A tag points at a commit of its own
  repository, so the release creates `desktop-v<version>` in
  simplexai-labs/linger at that repository's default branch, and its notes
  name only the version.

simplexai-labs/linger is public, and so are its workflow logs and release
notes. The bundled archives come from the assets of the
[`native-deps`](https://github.com/simplexai-labs/linger/releases/tag/native-deps)
prerelease, which is public too; a `LINGER_NATIVE_DEPS_URL` secret or variable
points the build at another folder, and a secret keeps that address masked in
the log. Signing keys are written to files under the runner's temporary
folder, read only by the signing tools and removed after the build.

Set these under Settings → Secrets and variables → Actions of the repository
that runs the workflow:

| Name                            | Kind                 | Required                                  | Purpose                                                                                                                                                 |
| ------------------------------- | -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LINGER_NATIVE_DEPS_URL`        | secret (or variable) | no                                        | Folder serving the archives `apps/desktop/distribution/*.json` pins; the `native-deps` prerelease when unset. Each download is checked against its pin. |
| `RELEASE_REPO`                  | variable             | no                                        | `owner/name` that receives the release; `simplexai-labs/linger` when unset.                                                                             |
| `LINGER_RELEASE_TOKEN`          | secret               | when `RELEASE_REPO` is another repository | Fine-grained token for `RELEASE_REPO` only, with Contents: read and write. Not needed in simplexai-labs/linger itself.                                  |
| `MACOS_DEVELOPER_ID_P12_BASE64` | secret               | no                                        | Base64 of the Developer ID `.p12`. Without it the app is signed ad hoc.                                                                                 |
| `MACOS_DEVELOPER_ID_PASSWORD`   | secret               | with the `.p12`                           | Password of that `.p12`.                                                                                                                                |
| `MACOS_NOTARY_KEY_JSON`         | secret               | no                                        | App Store Connect API key JSON; needs the Developer ID.                                                                                                 |
| `DESKTOP_UPDATE_KEY_PEM`        | secret               | no                                        | Ed25519 private key (PEM) for the macOS update feed. Without it no feed is built.                                                                       |
| `WINDOWS_SIGNING_P12_BASE64`    | secret               | no                                        | Base64 of an Authenticode `.p12`. Without it the setup program is unsigned.                                                                             |
| `WINDOWS_SIGNING_PASSWORD`      | secret               | with the `.p12`                           | Password of that `.p12`.                                                                                                                                |

### Bundled archives

The `native-deps` prerelease in simplexai-labs/linger holds every archive that
`apps/desktop/distribution/*.json` pins, under its file name; being a
prerelease, it never becomes the latest release. When a pin changes, upload the
new archive there before tagging:

```sh
gh release upload native-deps <archive> --repo simplexai-labs/linger
```

### First release in simplexai-labs/linger

1. Check that the `native-deps` prerelease has every pinned archive.
2. With the source in simplexai-labs/linger, push a prerelease tag first, then
   the release:

   ```sh
   git tag desktop-v0.16.36-rc.1 && git push origin desktop-v0.16.36-rc.1
   git tag desktop-v0.16.36 && git push origin desktop-v0.16.36
   ```

   From another repository, also set `LINGER_RELEASE_TOKEN` there and push
   the tags to that repository instead.

3. Check the release page, download each file and compare it with
   `SHA256SUMS.txt`. A test release is removed with its tag:
   `gh release delete desktop-v0.16.36-rc.1 --repo simplexai-labs/linger --cleanup-tag`.

## Release Files

| File                                        | Contents                                                        |
| ------------------------------------------- | --------------------------------------------------------------- |
| `Linger-<version>-arm64.dmg`                | macOS, Apple silicon                                            |
| `Linger-<version>-linux-x64.tar.gz`         | Linux x64 (glibc 2.35 or newer for the bundled Native services) |
| `Linger-<version>-windows-x64-setup.exe`    | Windows x64 per-user installer                                  |
| `Linger-<version>-windows-x64-portable.zip` | Windows x64 folder to run without installing                    |
| `Linger-<version>-darwin-update-feed.tar`   | only with the update key: the macOS self-update feed            |
| `SHA256SUMS.txt`                            | SHA-256 of every file above                                     |

Each package bundles the source package, PostgreSQL, voice tools, TeamHub and
the Native services as described in
[Packaging Details](#packaging-details). The update feed holds
`manifest.json`, `manifest.json.sig` and the app archive; unpack it into the
server's `install/desktop/stable/`.

## Local Build

On Linux x64 with Docker, Node, pnpm, Go and Python 3:

```sh
DESKTOP_VERSION=0.16.36-rc.1 RCODESIGN=/path/to/rcodesign \
  scripts/ci/desktop-release.sh build darwin-arm64
scripts/ci/desktop-release.sh checksums .linger-runtime/desktop-release/assets 0.16.36-rc.1
```

With the archives already in `LINGER_NATIVE_POSTGRES_DIR` (default
`~/.cache/linger-desktop`), `LINGER_NATIVE_DEPS_URL` is not needed.
`checksums` refuses a folder without the DMG, the Linux archive and the setup
program of that version.

## Packaging Details

Paths in this section are relative to `apps/desktop/`, except
`scripts/prepare-native-*.mjs`, `scripts/source-native.mjs`,
`scripts/installs/`, and `packages/local-installation/`, which are in the
repository root.

### Source Package

Release builds set `LINGER_SOURCE_ARCHIVE_URL` (https) and
`LINGER_SOURCE_ARCHIVE_SHA256` before `node build.mjs`. Produce them from the
release tag in the repository root:

```sh
SOURCE_ARCHIVE_REF=v1.2.3 \
SOURCE_ARCHIVE_URL_BASE=https://github.com/simplexai-labs/linger/releases/download/v1.2.3 \
  make source-archive
```

Upload `.linger-runtime/source-archive/linger-v1.2.3.tar.gz` to that release
and take both values from `source-archive.json` next to it. One commit always
gives the same digest. To ship the package inside the app instead (about
45 MB more, no hosting needed), set `LINGER_SOURCE_ARCHIVE_FILE` to the
archive; the build copies it beside the installer and pins its digest. Without
either (and without `LINGER_CHECKOUT`) the build does not offer a
local install.

A downloaded source package can have a dependency store for each platform
beside it, so the native install of its packages needs no registry. Build it
from the same tag, on the platform it serves, and set
`LINGER_SOURCE_DEPENDENCIES_URL` and `LINGER_SOURCE_DEPENDENCIES_SHA256` from
`source-dependencies-<target>.json` for that platform's build:

```sh
SOURCE_ARCHIVE_REF=v1.2.3 \
SOURCE_ARCHIVE_URL_BASE=https://github.com/simplexai-labs/linger/releases/download/v1.2.3 \
  make source-dependencies
```

`SOURCE_DEPENDENCIES_TARGET` builds another platform's store instead (the
`source-dependencies` CI job does this on Linux). Such a store skips install
scripts, so the install still compiles or downloads native modules such as
better-sqlite3. The desktop downloads the store after the source package
(resuming an interrupted download) and unpacks it into
`.linger-runtime/pnpm-store` of the source; when that fails it logs
`local_server.dependencies_failed` and the installer downloads the packages
itself.

`LINGER_SOURCE_ARCHIVE_MIRRORS` and `LINGER_SOURCE_DEPENDENCIES_MIRRORS` list
other https hosts serving the same files, separated by spaces. The desktop moves
to the next one when a host fails or stalls, and the SHA-256 still decides.

Native installs also need the publisher's pinned localmodels tool and native
PostgreSQL package for the target. They are pinned in
`distribution/<target>.json`, in the shape `packages/local-installation/src/native-dependencies.ts` reads
(`platform`, `arch`, `localmodelsTool`, `nativeSources`, `voiceTools`, each
source with an optional `mirrors` list of https URLs for the same file). The build copies the
file of its target (`LINGER_DESKTOP_DAEMON_TARGETS`, else this machine) beside
the bundled installer, which reads it at start; `LINGER_DESKTOP_DISTRIBUTION`
names another file instead. A source with `file` (Windows) instead of `url`
names an archive the app ships: the build copies it from
`LINGER_NATIVE_POSTGRES_DIR` (default `~/.cache/linger-desktop`) to
`dist/installer/native/` after checking its size and sha256, and the installer
checks them again before extracting it, as it does for a download. Where the
file has no PostgreSQL for the computer, or the bundled archive is missing,
the setup page does not offer installing on this computer. `src/main/distribution.test.ts` checks that each file holds its
target's PostgreSQL and the localmodels release `scripts/installs/stack.sh`
pins.

### Release

Each desktop target (`darwin-arm64`, `linux-x64`) gets its own distribution
file and build. For one release:

1. Make the source package as above and upload it. On a host of each target,
   make its dependency store and upload it beside the package.
2. On a host of each target, build the PostgreSQL package with
   `node scripts/prepare-native-postgres.mjs --output DIR --base-url URL`; it
   refuses to cross-build. Before uploading, check `initdb`, a connection and
   `CREATE EXTENSION vector` against a private data directory. Upload the
   `.tar.gz` to `URL` and keep `postgres-<target>.json` from `DIR`. Windows
   repackages the pinned EDB binaries, builds only pgvector and adds the
   Visual C++ runtime the EDB zip leaves out, so run it there from an x64
   Native Tools Command Prompt for Visual Studio. The installer accepts only
   credential-free HTTPS URLs, so `URL` must be the HTTPS CDN.
3. For a new PostgreSQL or localmodels release, update
   `distribution/<target>.json`: `localmodelsTool` for the localmodels
   release `scripts/installs/stack.sh` pins, and `nativeSources` holding that target's
   `postgres-<target>.json` object.
4. Build with `LINGER_DESKTOP_DAEMON_TARGETS` set to the target and the source package
   (`LINGER_SOURCE_ARCHIVE_FILE`, or the URL and SHA256, plus the target's
   `LINGER_SOURCE_DEPENDENCIES_URL` and SHA256) set, then package (`packaging/mac/package.py
--arch arm64` for macOS, `packaging/linux/package.py` for Linux).
5. Check the package on a clean computer: Quick Install with the default
   source ends on "Linger is ready" and Open Linger shows the local server,
   signed in, with this computer connected.

Official releases come from the public simplexai-labs/linger repository: a
`desktop-v<version>` tag pushed there runs steps 4 and the packaging for
`darwin-arm64`, `linux-x64` and `win32-x64` in GitHub Actions and publishes a
linger GitHub Release with `SHA256SUMS.txt`; see
[How the workflow runs](#how-the-workflow-runs). The workflow
fetches the bundled archives from the assets of the `native-deps` prerelease
there, so upload a new pinned archive to it before tagging.

Windows, Linux x64 and Apple silicon bundle PostgreSQL in the app instead
(`file` in `distribution/<target>.json`; 35 MB on Windows, 10–12 MB
elsewhere), so Native works without the CDN. Put the pinned archives in
`LINGER_NATIVE_POSTGRES_DIR` before `node build.mjs`; the build fails without
them. To download it instead, replace `file` with the HTTPS `url` once it is on
the CDN. Native PostgreSQL refuses an elevated Linger ("Run as
administrator"), as it refuses root elsewhere.

Every target also bundles the voice tools (`voiceTools`, about 40 MB each):
the official LiveKit server release (Apple silicon: built from the tagged
source with the pinned Go, since LiveKit publishes no macOS binary; without
cgo, so its vendored go-osstat reports an idle CPU, which only matters when
LiveKit spreads rooms over several servers) and a
static LGPL ffmpeg/ffprobe (Linux and Windows: built from the FFmpeg release
in the pinned Alpine image, Windows with MinGW-w64; Apple silicon: the
pinned serversideup LGPL build, which links OpenSSL statically). Make them on
Linux with `node scripts/prepare-native-voice-tools.mjs --target <target>
--output DIR` (Docker; Go for Apple silicon), copy the archive to
`LINGER_NATIVE_POSTGRES_DIR` and `voice-tools-<target>.json` from `DIR` into
`voiceTools`. The build is reproducible except for the Go toolchain download,
and it checks the versions, the ffmpeg components the voice workers use,
static linking and the Mach-O signatures. Licenses ship in `licenses/` of the
archive. On every install and start, whether or not a voice key is saved,
Native extracts the archive into
`tools/native/components`, puts its `bin` first on the services' `PATH`
(TeamHub and the voice workers run `ffmpeg`/`ffprobe` from it) and runs
`livekit-server` as the `livekit` Native service: loopback only, HTTP and
WebSocket on one free port and media on one free UDP port, both kept with
the generated API key and secret in the owner-only `livekit.env` of the
instance, logs in `native/logs/livekit.log`. ICE over TCP stays off because
LiveKit binds it on every interface. Without the tools for the computer, or
when they fail to prepare, Native logs it, keeps voice off, gives TeamHub
`TEAMHUB_VOICE_MEDIA=off` and finishes the install. The macOS tools are ad-hoc signed by their linker and
live in the archive, outside the app's signature, like PostgreSQL.

A build with a source package for `win32-x64`, `linux-x64` or `darwin-arm64`
also ships TeamHub prebuilt (`scripts/build-teamhub.mjs`): build.mjs
cross-compiles `teamhub`, `migrate` and `account` from that package (`go` in
PATH, `CGO_ENABLED=0`) into `dist/installer/native/teamhub-<target>/` with a
`manifest.json` of their sha256, the package's sha256 and the commit
`git archive` recorded in it; a downloaded package
(`LINGER_SOURCE_ARCHIVE_URL`) is fetched for this. The package scripts
refuse binaries that do not match the manifest or the bundled package
(`packaging/native_bundle.py`). The desktop copies them into the unpacked source
(`.simplexai-runtime/prebuilt/`), the installer checks them again and then
skips the Go download, and `scripts/source-native.mjs` runs them (checking the
sha256 before each start) instead of `go run` / `go build`. Without them, or
when they do not verify, Native downloads Go and compiles as before.

The same targets ship the services Native runs, built from that package
(`scripts/build-native-runtime.mjs`): Web's production files, Node
Services bundled with esbuild beside the node_modules it loads at runtime,
and the pinned Node.js, in `dist/installer/native/runtime-<target>/` with a
`manifest.json` (schema 1). Windows and Linux ship `runtime.tar.zst` beside
the Node.js release archive. Apple silicon ships the `runtime/` folder and
`node/bin/node` unpacked instead, because the app's signature must cover
every Mach-O file: `packaging/mac/package.py` signs them with the app (Node.js
with `node-entitlements.plist`: JIT, and native modules under the hardened
runtime its release signature keeps), records the signed bytes in the
manifests and seals them with a shallow signature. The desktop unpacks or
copies the services into `.simplexai-runtime/offline/` of the source and
Node.js into its own folder, removing `com.apple.quarantine` on macOS;
`checkNativeRuntime` then verifies every file, and Native installs no
packages and needs no registry. On Linux the services need glibc 2.35
(Ubuntu 22.04, Debian 12), like the PostgreSQL build; with an older glibc the
desktop leaves them out and Native installs from the network. Model data
(OCR, Voice) is not bundled: Node Services downloads it on first use.
Intel Macs have none of this and install from the network.
