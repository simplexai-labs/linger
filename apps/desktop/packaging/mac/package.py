#!/usr/bin/env python3
"""Builds Linger-<version>-<arch>.dmg for Apple silicon and Intel on Linux.

Inputs: the desktop bundle from `node build.mjs` (dist/, which includes the
teamhub CLI and, built with LINGER_DESKTOP_DAEMON_TARGETS=darwin-arm64,darwin-x64,
the Go daemon for each arch) and the official Electron zip for each arch.
Tools: the `dmgtool` image from ./Dockerfile (hfsplus, dmg, ImageMagick) and
rcodesign for the signature Apple silicon requires.

    python3 packaging/mac/package.py [--arch arm64 --arch x64]
        [--rcodesign PATH] [--out DIR] [--update-archive]
        [--developer-id P12 --developer-id-password FILE [--notary-key JSON]]

Without --developer-id the app gets an ad-hoc signature and macOS asks the
user to confirm the first launch. --developer-id signs the app, its helpers
and the DMG with that Developer ID Application certificate, with the hardened
runtime and entitlements.plist. --notary-key, the App Store Connect
API key from `rcodesign encode-app-store-connect-api-key`, then notarizes and
staples the DMG in one Apple submission (which also notarizes the nested
Linger.app). When --update-archive is set, the already-issued ticket is stapled
onto Linger.app before packing the update archive. Linger.app inside the DMG is
notarized by Apple but not separately stapled, so dragging it out of the DMG
and launching it for the first time completely offline relies on online ticket
lookup (or macOS's DMG ticket). Key and password files are only passed to
rcodesign.

The Go daemon goes to Contents/Resources/computer/ and is signed with the
app like every other Mach-O file. The browser and computer-control tools it
loads go to Contents/Resources/cli/ and runtime/ (../computer_tools.py); their
Node.js gets node-entitlements.plist like the Native one, and their manifest
records the signed bytes of the Mach-O files signing rewrote. Cua's driver
keeps the Developer ID signature Cua shipped it with: CuaDriver.app is
excluded from signing and the standalone cua-driver is put back after it, as
macOS grants it Accessibility and Screen Recording by that identity. The
signed app is checked for the tools. So are the Native services, Node.js and
TeamHub binaries build.mjs bundles for Apple silicon (dist/installer/native/,
checked by ../native_bundle.py): Node.js gets node-entitlements.plist for its
JIT and, as it keeps the hardened runtime of its release signature, for the
native modules it loads; their manifests then record the signed bytes before a shallow signature
seals them. The desktop copies them out of the app as they are.

--update-archive also writes <out>/Linger-<version>-<arch>.app.tar.gz, the
signed app the installed app replaces itself with. The release's signed
manifest lists it (scripts/ci/desktop-release.sh manifest).
"""
import argparse
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))
from archive import sha256, tar_gz  # noqa: E402
import computer_tools  # noqa: E402
from native_bundle import check_runtime, check_teamhub, refresh  # noqa: E402
BUNDLE_ID = "com.simplexai.linger.desktop.preview"
# Prompt text for the privacy permissions tasks and voice need. Without
# NSAppleEventsUsageDescription macOS refuses Apple Events without asking.
# The microphone text replaces Electron's generic one; the prompt itself also
# needs the audio-input entitlement in entitlements.plist.
PRIVACY_USAGE = {
    "NSMicrophoneUsageDescription": "Linger uses the microphone for voice conversations and meeting recordings you start.",
    "NSAppleEventsUsageDescription": "Tasks you send to Linger can control apps on this Mac for you.",
    "NSDownloadsFolderUsageDescription": "Tasks you send to Linger can read and organize your downloads.",
    "NSDocumentsFolderUsageDescription": "Tasks you send to Linger can read and edit your documents.",
    "NSDesktopFolderUsageDescription": "Tasks you send to Linger can read and edit files on your desktop.",
}
# macOS refuses to open the app on an older system. The bundled PostgreSQL and
# LiveKit's ffmpeg are built for 14.0; keep in step with MIN_MACOS in
# src/main/local-server.ts.
MINIMUM_MACOS = "14.0"
# Targets build.mjs bundles the Native services for; Intel Macs install them
# from the network.
NATIVE_TARGETS = {"darwin-arm64"}
NATIVE = os.path.join("Contents", "Resources", "app", "dist", "installer", "native")
RESOURCES = os.path.join("Contents", "Resources")
TOOLS_NODE = "Contents/Resources/runtime/bin/node"
CUA = "Contents/Resources/cli/computer-tools/cua"
# Signed by Cua with its own entitlements; signing leaves the app bundle alone
# and package.py puts the standalone driver back after it.
CUA_APP = f"{CUA}/CuaDriver.app"
CUA_VENDOR_SIGNED = ["cua/cua-driver"]


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def dmgtool(workdir, *args):
    run("docker", "run", "--rm", "-v", f"{workdir}:/w", "-w", "/w", "dmgtool", *args)


def electron_zip(version, arch, cache):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"electron-v{version}-darwin-{arch}.zip")
    if not os.path.exists(path):
        mirror = os.environ.get("ELECTRON_MIRROR", "https://github.com/electron/electron/releases/download/")
        url = f"{mirror}v{version}/electron-v{version}-darwin-{arch}.zip"
        print(f"downloading {url}")
        with urllib.request.urlopen(url) as response, open(path + ".part", "wb") as out:
            shutil.copyfileobj(response, out)
        os.rename(path + ".part", path)
    return path


def extract_app(zip_path, destination):
    """Copies Electron.app to destination/Linger.app, keeping symlinks and modes."""
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            if not info.filename.startswith("Electron.app/"):
                continue
            target = os.path.join(destination, "Linger.app" + info.filename[len("Electron.app"):])
            mode = info.external_attr >> 16
            if info.filename.endswith("/"):
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            data = archive.read(info)
            if stat.S_ISLNK(mode):
                os.symlink(data.decode(), target)
            else:
                with open(target, "wb") as out:
                    out.write(data)
                os.chmod(target, (mode & 0o777) or 0o644)
    return os.path.join(destination, "Linger.app")


def update_plist(path, **values):
    with open(path, "rb") as source:
        info = plistlib.load(source)
    info.update(values)
    with open(path, "wb") as out:
        plistlib.dump(info, out)


def write_icon(resources):
    """electron.icns is the logo's macOS icon (apps/assets/logo/macos)."""
    shutil.copy(os.path.join(DESKTOP, "resources", "linger.icns"), os.path.join(resources, "electron.icns"))


# With the grammatical-gender variants Chromium picks from the user's settings.
KEPT_LOCALES = re.compile(r"(?:en|zh_CN)(?:_FEMININE|_MASCULINE|_NEUTER)?\.lproj")


def remove_locales(contents):
    """The app speaks English and Chinese; Chromium falls back to English."""
    for root, folders, _ in os.walk(contents):
        for name in list(folders):
            if name.endswith(".lproj") and not KEPT_LOCALES.fullmatch(name):
                shutil.rmtree(os.path.join(root, name))
                folders.remove(name)


def stage_app(arch, version, electron_version, workdir, cache):
    stage = os.path.join(workdir, "stage")
    app = extract_app(electron_zip(electron_version, arch, cache), stage)
    contents = os.path.join(app, "Contents")
    resources = os.path.join(contents, "Resources")
    # Electron treats a bundle with default_app.asar, or an executable named
    # "Electron", as unpackaged.
    default_app = os.path.join(resources, "default_app.asar")
    if os.path.exists(default_app):
        os.remove(default_app)
    remove_locales(contents)

    dist = os.path.join(DESKTOP, "dist")
    app_dir = os.path.join(resources, "app")
    target = f"darwin-{arch}"

    def ignore(directory, names):
        ignored = set(shutil.ignore_patterns("*.map", "computer", "computer-tools")(directory, names))
        # The other arch's Native services.
        if os.path.basename(directory) == "native":
            ignored |= {name for name in names if name.startswith(("runtime-", "teamhub-"))
                        and not name.endswith(target)}
        return ignored

    shutil.copytree(dist, os.path.join(app_dir, "dist"), ignore=ignore, symlinks=True)
    with open(os.path.join(app_dir, "package.json"), "w") as out:
        json.dump({"name": "linger-desktop", "productName": "Linger", "version": version,
                   "type": "module", "main": "dist/main/index.mjs"}, out, indent=2)
    computer = os.path.join(resources, "computer")
    os.makedirs(computer)
    shutil.copy2(daemon_binary(arch), computer)
    computer_tools.copy(resources, target)
    write_icon(resources)

    os.rename(os.path.join(contents, "MacOS", "Electron"), os.path.join(contents, "MacOS", "Linger"))
    update_plist(os.path.join(contents, "Info.plist"), CFBundleName="Linger",
                 CFBundleDisplayName="Linger", CFBundleExecutable="Linger",
                 CFBundleIdentifier=BUNDLE_ID, CFBundleShortVersionString=version,
                 CFBundleVersion=version, LSMinimumSystemVersion=MINIMUM_MACOS,
                 **PRIVACY_USAGE)
    frameworks = os.path.join(contents, "Frameworks")
    for name in sorted(os.listdir(frameworks)):
        if not (name.startswith("Electron Helper") and name.endswith(".app")):
            continue
        suffix = name[len("Electron Helper"):-len(".app")]
        helper = f"Linger Helper{suffix}"
        old = os.path.join(frameworks, name)
        os.rename(os.path.join(old, "Contents", "MacOS", name[:-4]),
                  os.path.join(old, "Contents", "MacOS", helper))
        # The helper plists have no CFBundleExecutable of their own; without
        # it macOS cannot start the renamed executable.
        update_plist(os.path.join(old, "Contents", "Info.plist"), CFBundleExecutable=helper,
                     CFBundleName=helper, CFBundleDisplayName=helper,
                     CFBundleIdentifier=BUNDLE_ID + ".helper" + suffix.replace(" ", "").replace("(", ".").replace(")", "").lower())
        os.rename(old, os.path.join(frameworks, helper + ".app"))
    os.symlink("/Applications", os.path.join(stage, "Applications"))
    return stage, app


def daemon_binary(arch):
    return os.path.join(DESKTOP, "dist", "computer", f"darwin-{arch}", "linger-computer-daemon")


def bundled_node(path):
    """Whether the bundle-relative path is the Node.js of a Native runtime or
    of the Computer tools."""
    parts = path.split("/")
    return path == TOOLS_NODE or (path.startswith(NATIVE + "/") and len(parts) == 10
            and parts[6].startswith("runtime-") and parts[7:] == ["node", "bin", "node"])


FAT_MAGIC = b"\xca\xfe\xba\xbe"
MACHO_MAGIC = {b"\xcf\xfa\xed\xfe", FAT_MAGIC}


def macho_files(app):
    """Bundle-relative paths of the Mach-O files in app, sorted."""
    found = []
    for root, _, files in os.walk(app):
        for name in files:
            path = os.path.join(root, name)
            if os.path.islink(path):
                continue
            with open(path, "rb") as source:
                if source.read(4) in MACHO_MAGIC:
                    found.append(os.path.relpath(path, app))
    return sorted(found)


def _be32(data, at):
    return int.from_bytes(data[at:at + 4], "big")


def _le32(data, at):
    return int.from_bytes(data[at:at + 4], "little")


def developer_id_signed(data):
    """Whether every slice of the Mach-O in data has a certificate signature
    with the hardened runtime, which notarization requires. A linker's ad-hoc
    signature has neither."""
    if data[:4] == FAT_MAGIC:
        entries = [8 + 20 * index for index in range(_be32(data, 4))]
        images = [data[_be32(data, at + 8):_be32(data, at + 8) + _be32(data, at + 12)] for at in entries]
    else:
        images = [data]
    for image in images:
        if image[:4] != b"\xcf\xfa\xed\xfe":
            return False
        signature, cursor = b"", 32
        for _ in range(_le32(image, 16)):
            if _le32(image, cursor) == 0x1D:  # LC_CODE_SIGNATURE
                start = _le32(image, cursor + 8)
                signature = image[start:start + _le32(image, cursor + 12)]
            cursor += _le32(image, cursor + 4)
        if _be32(signature, 0) != 0xFADE0CC0:  # embedded signature superblob
            return False
        blobs = {_be32(signature, 12 + 8 * index): signature[_be32(signature, 16 + 8 * index):]
                 for index in range(_be32(signature, 8))}
        flags = _be32(blobs.get(0, b""), 12)  # the CodeDirectory's flags
        cms = blobs.get(0x10000, b"")  # the CMS signature blob, empty when ad-hoc
        if flags & 0x2 or not flags & 0x10000 or _be32(cms, 4) <= 8:
            return False
    return True


def unsigned_archive_files(archive):
    """Mach-O files in the tar.gz archive that lack a Developer ID signature."""
    unsigned = []
    with tarfile.open(archive) as tar:
        for member in tar:
            if member.isfile():
                data = tar.extractfile(member).read()
                if data[:4] in MACHO_MAGIC and not developer_id_signed(data):
                    unsigned.append(member.name)
    return unsigned


def check_bundled_archives(app):
    """Apple inspects the archives inside the app and refuses to notarize it
    while one holds a Mach-O file without a Developer ID signature."""
    native = os.path.join(app, NATIVE)
    for name in sorted(os.listdir(native)) if os.path.isdir(native) else []:
        if name.endswith(".tar.gz"):
            unsigned = unsigned_archive_files(os.path.join(native, name))
            if unsigned:
                sys.exit(f"{name} holds {len(unsigned)} Mach-O files without a Developer ID signature "
                         f"(first: {unsigned[0]}); run the Sign macOS native archives workflow on this "
                         "branch and commit the pins it produces (docs/desktop-release.md#bundled-archives)")


def signing_scopes(app, path):
    """rcodesign scopes that select every architecture of the Mach-O at path.

    rcodesign reads the text after the last "@" of a scope as an architecture
    selector, so a path under an npm scope (node_modules/@img/...) names each
    slice explicitly instead; rcodesign numbers a thin file's only slice 0.
    """
    if "@" not in path:
        return [path]
    with open(os.path.join(app, path), "rb") as source:
        header = source.read(8)
    slices = _be32(header, 4) if header[:4] == FAT_MAGIC else 1
    return [f"{path}@{index}" for index in range(slices)]


class Signing:
    """How the app and the DMG are signed; renaming the executables
    invalidated Electron's own signature."""

    def __init__(self, rcodesign, developer_id=None, password_file=None, notary_key=None):
        if (developer_id is None) != (password_file is None):
            sys.exit("--developer-id and --developer-id-password go together")
        if notary_key and not developer_id:
            sys.exit("--notary-key needs --developer-id: Apple notarizes only Developer ID signatures")
        self.rcodesign = rcodesign
        self.developer_id = developer_id
        self.password_file = password_file
        self.notary_key = notary_key

    def _identity(self):
        if not self.developer_id:
            return []
        return ["--p12-file", self.developer_id, "--p12-password-file", self.password_file]

    def app_args(self, app, shallow=False):
        # rcodesign applies these per path. The bundled Node.js gets the
        # entitlements its JIT and native modules need; rcodesign keeps the
        # hardened runtime flag of its release signature even when ad-hoc.
        # With a Developer ID every Mach-O also gets the hardened runtime Apple
        # requires, and the app and its helpers, which run JavaScript too, the
        # entitlements. --for-notarization refuses a certificate Apple would
        # reject before the upload.
        entitlements = os.path.join(HERE, "entitlements.plist")
        node_entitlements = os.path.join(HERE, "node-entitlements.plist")
        scoped = []
        for path in macho_files(app):
            javascript = path.startswith("Contents/MacOS/") or ".app/Contents/MacOS/" in path
            for scope in signing_scopes(app, path):
                if self.developer_id:
                    scoped += ["--code-signature-flags", f"{scope}:runtime"]
                if bundled_node(path):
                    scoped += ["--entitlements-xml-file", f"{scope}:{node_entitlements}"]
                elif self.developer_id and javascript:
                    scoped += ["--entitlements-xml-file", f"{scope}:{entitlements}"]
        check = ["--for-notarization"] if self.notary_key else []
        depth = ["--shallow"] if shallow else []
        return [self.rcodesign, "sign", *self._identity(), *check, *depth, *scoped,
                "--exclude", CUA_APP, app]

    def dmg_args(self, dmg):
        return [self.rcodesign, "sign", *self._identity(), dmg]

    def sign_app(self, app, target):
        run(*self.app_args(app))
        # Signing rewrote the bundled Mach-O files; their manifests are
        # resources, which a shallow signature seals again. It signs no
        # Mach-O file, so the vendor-signed driver put back stays as it is.
        native = os.path.join(app, NATIVE)
        if os.path.isdir(native):
            refresh(native, target)
        resources = os.path.join(app, RESOURCES)
        staged = os.path.join(computer_tools.STAGED, target, computer_tools.TOOLS)
        for relative in CUA_VENDOR_SIGNED:
            shutil.copy2(os.path.join(staged, relative),
                         os.path.join(resources, computer_tools.TOOLS, relative))
        computer_tools.refresh_signed(resources, kept=CUA_VENDOR_SIGNED)
        run(*self.app_args(app, shallow=True))
        computer_tools.check(resources, target)

    def sign_dmg(self, dmg):
        # An ad-hoc DMG signature adds nothing; Gatekeeper needs a Developer ID.
        if self.developer_id:
            run(*self.dmg_args(dmg))

    def notarize(self, path):
        """Waits for Apple's verdict and staples the ticket to path."""
        if self.notary_key:
            run(self.rcodesign, "notary-submit", "--api-key-file", self.notary_key,
                "--wait", "--max-wait-seconds", "3600", "--staple", path)

    def staple(self, path, attempts=5, delay_seconds=5):
        """Attaches Apple's already-issued notarization ticket to path."""
        if not self.notary_key:
            return
        for attempt in range(1, attempts + 1):
            try:
                run(self.rcodesign, "staple", path)
                return
            except subprocess.CalledProcessError:
                if attempt == attempts:
                    raise
                time.sleep(delay_seconds)


def build_dmg(stage, workdir, output, volume_name):
    size = sum(os.path.getsize(os.path.join(root, f)) for root, _, files in os.walk(stage)
               for f in files if not os.path.islink(os.path.join(root, f)))
    volume = os.path.join(workdir, "vol.hfs")
    with open(volume, "wb") as out:
        # Generous: libdmg-hfsplus fails on a nearly full volume, and free
        # space compresses away in the DMG.
        out.truncate(size * 2 + 128 * 1024 * 1024)
    for asset in ("background.tiff", "dsstore.py"):
        shutil.copy(os.path.join(HERE, asset), os.path.join(workdir, asset))
    # Run the HFS+ and UDIF steps in one container invocation. The Finder
    # layout in DS_Store points at the background by catalog ID, so /.background
    # and its image must be the first items (IDs 16 and 17).
    script = (
        'python3 dsstore.py DS_Store "$1" && '
        'mkfs.hfsplus -v "$1" vol.hfs && '
        'hfsplus vol.hfs mkdir /.background && '
        'hfsplus vol.hfs add background.tiff /.background/background.tiff && '
        'hfsplus -s clone_link vol.hfs addall stage > /dev/null && '
        'hfsplus vol.hfs add DS_Store /.DS_Store && '
        'dmg dmg vol.hfs out.dmg'
    )
    dmgtool(workdir, "sh", "-ec", script, "_", volume_name)
    # The container writes out.dmg as root; a copy is this user's to sign.
    shutil.copyfile(os.path.join(workdir, "out.dmg"), output)
    os.remove(os.path.join(workdir, "out.dmg"))


def update_archive(app, output):
    """The signed bundle as Linger.app/ in a tar.gz; tar keeps its symlinks."""
    tar_gz(os.path.dirname(app), os.path.basename(app), output)
    print(f"{output} {os.path.getsize(output)} sha256={sha256(output)}", flush=True)


def emit_outputs(stage, app, workdir, out_dir, version, arch, signing, include_update_archive):
    """Produces the signed/notarized DMG and optional update archive.

    Submits only the DMG to Apple's notary service (notarizing both the DMG
    and its nested Linger.app in one pass and stapling the DMG). When
    --update-archive is set, staples that already-issued ticket onto Linger.app
    before packing the update archive. Linger.app inside the DMG is notarized
    by Apple but does not carry a separately stapled ticket.
    """
    output = os.path.join(out_dir, f"Linger-{version}-{arch}.dmg")
    build_dmg(stage, workdir, output, f"Linger {version}")
    signing.sign_dmg(output)
    signing.notarize(output)
    print(f"{output} {os.path.getsize(output)} sha256={sha256(output)}", flush=True)
    if include_update_archive:
        signing.staple(app)
        archive = os.path.join(out_dir, f"Linger-{version}-{arch}.app.tar.gz")
        update_archive(app, archive)
        computer_tools.check_archive(archive, "Linger.app/Contents/Resources/", f"darwin-{arch}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arch", action="append", choices=["arm64", "x64"])
    parser.add_argument("--rcodesign", default=shutil.which("rcodesign") or "rcodesign")
    parser.add_argument("--out", default=os.path.join(DESKTOP, "out"))
    parser.add_argument("--cache", default=os.path.expanduser("~/.cache/linger-desktop"))
    parser.add_argument("--update-archive", action="store_true",
                        help="also write the app archive installed apps update from")
    parser.add_argument("--developer-id", help="Developer ID Application certificate and key (.p12)")
    parser.add_argument("--developer-id-password", help="file holding the .p12 password")
    parser.add_argument("--notary-key", help="App Store Connect API key (JSON) for notarization")
    args = parser.parse_args()
    signing = Signing(args.rcodesign, args.developer_id, args.developer_id_password, args.notary_key)
    with open(os.path.join(DESKTOP, "package.json")) as source:
        package = json.load(source)
    version = package["version"]
    electron_version = package["devDependencies"]["electron"].lstrip("^~")
    arches = args.arch or ["arm64", "x64"]
    for arch in arches:
        if not os.path.exists(daemon_binary(arch)):
            sys.exit(f"dist/ is missing the daemon for darwin-{arch}; run "
                     "`LINGER_DESKTOP_DAEMON_TARGETS=darwin-arm64,darwin-x64 node build.mjs` first")
    for arch in arches:
        if f"darwin-{arch}" in NATIVE_TARGETS:
            check_teamhub(f"darwin-{arch}")
            check_runtime(f"darwin-{arch}")
    os.makedirs(args.out, exist_ok=True)
    for arch in arches:
        workdir = tempfile.mkdtemp(prefix=f"linger-dmg-{arch}-")
        try:
            stage, app = stage_app(arch, version, electron_version, workdir, args.cache)
            if args.notary_key:
                check_bundled_archives(app)
            signing.sign_app(app, f"darwin-{arch}")
            computer_tools.check(os.path.join(app, RESOURCES), f"darwin-{arch}")
            emit_outputs(stage, app, workdir, args.out, version, arch, signing, args.update_archive)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
