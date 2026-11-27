#!/usr/bin/env python3
"""Builds Linger-<version>-x64-setup.exe and Linger-<version>-x64.zip on Linux.

Inputs: the desktop bundle from `node build.mjs` (dist/, which includes the
teamhub CLI and, built with LINGER_DESKTOP_DAEMON_TARGETS=win32-x64, the Go
daemon) and the official Electron zip for win32-x64.
Tools: the `wintool` image from ./Dockerfile (NSIS, ImageMagick, resedit).

    docker build -t wintool packaging/win
    python3 packaging/win/package.py [--out DIR]

The setup program installs for the current user into
%LOCALAPPDATA%\\Programs\\Linger without administrator rights, adds a Start
menu shortcut and an entry under Installed apps. The zip holds the same
folder for running without installing.

Neither is Authenticode-signed yet, so SmartScreen asks the user to confirm
the first start. The desktop updater runs a newer setup program with
/update /relaunch: it stops Linger, replaces the installed version behind a
progress page and starts it again. The zip has no self-update.

The Go daemon goes to resources/computer/ and the browser and computer-control
tools it loads to resources/cli/ and resources/runtime/ (../computer_tools.py);
a portable PowerShell 7 runtime goes to resources/runtime/pwsh/ on Windows, and
the finished zip is checked for them. With a bundled source package, the
TeamHub binaries and the Native runtime build.mjs built from it must be there
and match their manifests and that package (../native_bundle.py).
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))
from archive import sha256  # noqa: E402
import computer_tools  # noqa: E402
from native_bundle import check_runtime, check_teamhub  # noqa: E402
DAEMON = os.path.join(DESKTOP, "dist", "computer", "win32-x64", "linger-computer-daemon.exe")
TEAMHUB_LAUNCHER = os.path.join(DESKTOP, "dist", "teamhub-cli", "teamhub.exe")
TEAMHUB_ARCHIVE_LAUNCHER = "Linger/resources/app/dist/teamhub-cli/teamhub.exe"
TEAMHUB_ARCHIVE_LEGACY_CMD = "Linger/resources/app/dist/teamhub-cli/teamhub.cmd"
PWSH_VERSION = "7.6.10"
PWSH_ARCHIVE = f"PowerShell-{PWSH_VERSION}-win-x64.zip"
PWSH_SHA256 = "7d871531806eb1646264e4bbabd9f0c30c23355591bc756bb9909448c29ae166"
PWSH_ARCHIVE_ENTRY = "Linger/resources/runtime/pwsh/pwsh.exe"
PWSH_DEFAULT_MIRROR = "https://github.com/PowerShell/PowerShell/releases/download/"


def verify_teamhub_cli_archive(archive):
    """Exits unless the finished zip holds a non-empty teamhub.exe and no teamhub.cmd."""
    with zipfile.ZipFile(archive) as source:
        sizes = {
            info.filename.replace("\\", "/"): info.file_size
            for info in source.infolist()
            if not info.is_dir()
        }
    if not sizes.get(TEAMHUB_ARCHIVE_LAUNCHER):
        sys.exit(f"{os.path.basename(archive)} is missing non-empty {TEAMHUB_ARCHIVE_LAUNCHER}")
    if TEAMHUB_ARCHIVE_LEGACY_CMD in sizes:
        sys.exit(f"{os.path.basename(archive)} must not contain {TEAMHUB_ARCHIVE_LEGACY_CMD}")


def verify_pwsh_archive(archive):
    """Exits unless the finished zip holds a non-empty bundled pwsh.exe."""
    with zipfile.ZipFile(archive) as source:
        sizes = {
            info.filename.replace("\\", "/"): info.file_size
            for info in source.infolist()
            if not info.is_dir()
        }
    if not sizes.get(PWSH_ARCHIVE_ENTRY):
        sys.exit(f"{os.path.basename(archive)} is missing non-empty {PWSH_ARCHIVE_ENTRY}")


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def wintool(workdir, *args):
    run("docker", "run", "--rm", "-u", f"{os.getuid()}:{os.getgid()}",
        "-v", f"{workdir}:/w", "-w", "/w", "wintool", *args)


def electron_zip(version, cache):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"electron-v{version}-win32-x64.zip")
    if not os.path.exists(path):
        mirror = os.environ.get("ELECTRON_MIRROR", "https://github.com/electron/electron/releases/download/")
        url = f"{mirror}v{version}/electron-v{version}-win32-x64.zip"
        print(f"downloading {url}")
        with urllib.request.urlopen(url) as response, open(path + ".part", "wb") as out:
            shutil.copyfileobj(response, out)
        os.rename(path + ".part", path)
    return path


def pwsh_zip(cache):
    """Returns the cached PowerShell 7 archive path after verifying SHA-256."""
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, PWSH_ARCHIVE)
    if os.path.exists(path):
        if sha256(path) == PWSH_SHA256:
            return path
        os.remove(path)
    mirror = os.environ.get("PWSH_MIRROR", PWSH_DEFAULT_MIRROR)
    if mirror and not mirror.endswith("/"):
        mirror += "/"
    url = f"{mirror}v{PWSH_VERSION}/{PWSH_ARCHIVE}"
    part = path + ".part"
    print(f"downloading {url}")
    try:
        with urllib.request.urlopen(url) as response, open(part, "wb") as out:
            shutil.copyfileobj(response, out)
        actual = sha256(part)
        if actual != PWSH_SHA256:
            sys.exit(f"{PWSH_ARCHIVE} sha256 mismatch: expected {PWSH_SHA256}, got {actual}")
        os.replace(part, path)
    except BaseException:
        if os.path.exists(part):
            os.remove(part)
        raise
    return path


def extract_pwsh(archive_path, destination):
    """Extracts the SHA-256-verified PowerShell archive into destination."""
    os.makedirs(destination, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(destination)
    pwsh_exe = os.path.join(destination, "pwsh.exe")
    if not os.path.isfile(pwsh_exe) or os.path.getsize(pwsh_exe) <= 0:
        sys.exit(f"{os.path.basename(archive_path)} is missing non-empty pwsh.exe")


def write_icon(output):
    """The logo's Windows icon (apps/assets/logo/windows), 16 to 256 px."""
    shutil.copy(os.path.join(DESKTOP, "resources", "linger.ico"), output)


KEPT_LOCALES = {"en-US.pak", "zh-CN.pak"}


def stage_app(version, electron_version, workdir, cache):
    stage = os.path.join(workdir, "Linger")
    with zipfile.ZipFile(electron_zip(electron_version, cache)) as archive:
        archive.extractall(stage)
    resources = os.path.join(stage, "resources")
    # Electron treats an app with default_app.asar as unpackaged.
    default_app = os.path.join(resources, "default_app.asar")
    if os.path.exists(default_app):
        os.remove(default_app)
    for name in ("LICENSES.chromium.html", "version"):
        if os.path.exists(os.path.join(stage, name)):
            os.remove(os.path.join(stage, name))
    # The app speaks English and Chinese; Chromium falls back to en-US.
    locales = os.path.join(stage, "locales")
    for name in os.listdir(locales):
        if name not in KEPT_LOCALES:
            os.remove(os.path.join(locales, name))

    dist = os.path.join(DESKTOP, "dist")
    app_dir = os.path.join(resources, "app")
    shutil.copytree(dist, os.path.join(app_dir, "dist"),
                    ignore=shutil.ignore_patterns("*.map", "computer", "computer-tools"))
    with open(os.path.join(app_dir, "package.json"), "w") as out:
        json.dump({"name": "linger-desktop", "productName": "Linger", "version": version,
                   "type": "module", "main": "dist/main/index.mjs"}, out, indent=2)
    computer = os.path.join(resources, "computer")
    os.makedirs(computer)
    shutil.copy2(DAEMON, computer)
    computer_tools.copy(resources, "win32-x64")
    extract_pwsh(pwsh_zip(cache), os.path.join(resources, "runtime", "pwsh"))

    write_icon(os.path.join(resources, "linger.ico"))
    os.rename(os.path.join(stage, "electron.exe"), os.path.join(stage, "Linger.exe"))
    shutil.copy(os.path.join(HERE, "resources.mjs"), workdir)
    wintool(workdir, "node", "resources.mjs", "Linger/Linger.exe", "Linger/resources/linger.ico", version)
    return stage


def build_setup(workdir, version, output):
    shutil.copy(os.path.join(HERE, "installer.nsi"), workdir)
    wintool(workdir, "makensis", "-V2", f"-DVERSION={version}",
            f"-DNUMERIC_VERSION={version.split('-')[0]}", "-DSTAGE=Linger",
            "-DOUTPUT=Linger-setup.exe", "installer.nsi")
    shutil.move(os.path.join(workdir, "Linger-setup.exe"), output)


# Extensions already compressed with high-entropy formats; storing them skips
# wasted DEFLATE work without growing the archive.
PRECOMPRESSED_EXTENSIONS = (".gz", ".tgz", ".zst", ".zip", ".xz", ".bz2", ".png", ".woff2")


def build_zip(stage, output):
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, _, files in os.walk(stage):
            for name in sorted(files):
                path = os.path.join(root, name)
                compress_type = (
                    zipfile.ZIP_STORED
                    if name.lower().endswith(PRECOMPRESSED_EXTENSIONS)
                    else zipfile.ZIP_DEFLATED
                )
                archive.write(
                    path,
                    os.path.join("Linger", os.path.relpath(path, stage)),
                    compress_type=compress_type,
                )


def report(path):
    print(f"{path} {os.path.getsize(path)} sha256={sha256(path)}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=os.path.join(DESKTOP, "out"))
    parser.add_argument("--cache", default=os.path.expanduser("~/.cache/linger-desktop"))
    args = parser.parse_args()
    with open(os.path.join(DESKTOP, "package.json")) as source:
        package = json.load(source)
    version = package["version"]
    electron_version = package["devDependencies"]["electron"].lstrip("^~")
    if not os.path.exists(DAEMON):
        sys.exit("dist/ is missing the daemon for win32-x64; run "
                 "`LINGER_DESKTOP_DAEMON_TARGETS=win32-x64 node build.mjs` first")
    if not os.path.isfile(TEAMHUB_LAUNCHER) or os.path.getsize(TEAMHUB_LAUNCHER) <= 0:
        sys.exit("dist/ is missing dist/teamhub-cli/teamhub.exe for win32-x64; run "
                 "`LINGER_DESKTOP_DAEMON_TARGETS=win32-x64 node build.mjs` first")
    check_teamhub("win32-x64")
    check_runtime("win32-x64")
    os.makedirs(args.out, exist_ok=True)
    workdir = tempfile.mkdtemp(prefix="linger-win-")
    try:
        stage = stage_app(version, electron_version, workdir, args.cache)
        setup = os.path.join(args.out, f"Linger-{version}-x64-setup.exe")
        archive = os.path.join(args.out, f"Linger-{version}-x64.zip")

        def make_setup():
            build_setup(workdir, version, setup)
            report(setup)

        def make_zip():
            build_zip(stage, archive)
            computer_tools.check_archive(archive, "Linger/resources/", "win32-x64")
            verify_teamhub_cli_archive(archive)
            verify_pwsh_archive(archive)
            report(archive)

        # Both read the finalized stage folder and write distinct outputs.
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(make_setup), pool.submit(make_zip)]
            for future in futures:
                future.result()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
