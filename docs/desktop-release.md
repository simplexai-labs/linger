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

The usual way is Actions → Cut desktop release → Run workflow. Pick `rc`,
`patch`, `minor` or `major` and the workflow reads the `desktop-v*` tags, works
out the next version and starts the Desktop release workflow for it on the
branch it ran from:

- `patch`, `minor` and `major` bump the latest stable version.
- `rc` continues the release candidates ahead of the latest stable version, or
  starts `rc.1` of its next patch version.
- `version` replaces the computed version; it is required while no stable
  `desktop-v*` tag exists. `dry_run` only prints the version.
- `draft` (on by default) leaves the release as a draft: edit the notes on the
  release page, then click Publish. Without it the release publishes itself.

Pushing a tag by hand does the same without the version arithmetic. In a
checkout of simplexai-labs/linger:

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
- The release is created as a draft, and is published only after every file is
  attached; a failed upload never leaves a half-filled release. The release
  appears under the repository's Releases with the files listed in
  [Release Files](#release-files).

## Release notes

The `release` job writes the notes with
[`scripts/ci/release-notes.mjs`](../scripts/ci/release-notes.mjs):

1. **Changes:** GitHub's generated notes list the pull requests merged since the
   previous release, grouped by the categories in
   [`.github/release.yml`](../.github/release.yml). A stable release is measured
   against the previous stable release, so it covers its release candidates; a
   release candidate is measured against the closest earlier release.
2. **Summary:** with the `ANTHROPIC_API_KEY` secret, Claude adds a headline,
   an introduction and a few highlights above the list. It sees only the pull
   request titles and authors, and its text is published as written, so keep
   `draft` on while you trust it less. Without the key, or when the call
   fails, the notes have no summary and the release still goes out.
3. **Footer:** the notes link the previous release and end with GitHub's full
   changelog link. A body is cut at 120,000 characters, under GitHub's limit.

The groups come from the pull request's label, and the
[`Pull request type labels`](../.github/workflows/pr-type-labels.yml) workflow
sets it from the type of the Conventional Commits title: `feat` is
`enhancement`, `fix` is `bug`, `perf` is `performance`, `docs` is
`documentation`, `build`, `chore`, `ci`, `refactor`, `revert`, `style` and
`test` are `maintenance`, and a `!` after the type adds `breaking-change`. The
workflow creates the `performance`, `maintenance` and `breaking-change` labels
when they are missing. A pull request with another title lands in "Other
changes", so the title is what decides where a change appears in the notes.

Generated notes list this repository's pull requests, so a release published
to another `RELEASE_REPO` keeps a one-line note.

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
| `ANTHROPIC_API_KEY`             | secret               | no                                        | Anthropic API key that writes the summary at the top of the release notes. Without it the notes hold only the pull request list.                        |
| `RELEASE_SUMMARY_MODEL`         | variable             | no                                        | Model that writes the summary; the default is set in `scripts/ci/release-notes.mjs`.                                                                    |
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
[`apps/desktop/AGENTS.md`](../apps/desktop/AGENTS.md). The update feed holds
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
