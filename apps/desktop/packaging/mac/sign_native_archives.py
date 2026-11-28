#!/usr/bin/env python3
"""Signs the Mach-O files inside the archives a macOS distribution bundles.

Apple inspects the archives inside the app (PostgreSQL, the voice tools) and
refuses to notarize it while one holds a Mach-O file without a Developer ID
signature, the hardened runtime and a secure timestamp. Their builds leave
the linker's ad-hoc signature, so a new pinned archive is signed once here,
uploaded beside the old one and pinned instead. Signing at every release would
change the archive's sha256 each time, and installs unpack each new digest
into a folder of its own.

    python3 packaging/mac/sign_native_archives.py --developer-id P12
        [--password-file FILE] [--distribution distribution/darwin-arm64.json]
        [--dir DIR] [--rcodesign PATH]

It reads each `file` source of the distribution from DIR (LINGER_NATIVE_POSTGRES_DIR,
default ~/.cache/linger-desktop), checks it against its pin, signs every
Mach-O member in place of the old bytes, writes the archive to DIR under the
name with the new sha256 and updates the pin. Archives already signed are left
as they are. Without --password-file it asks for the .p12 password once. The
Sign macOS native archives workflow runs it with the release's signing secrets.
"""
import argparse
import getpass
import gzip
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
from archive import sha256  # noqa: E402
from package import MACHO_MAGIC, developer_id_signed, unsigned_archive_files  # noqa: E402


def sign_archive(source, output, sign):
    """Copies the tar.gz source to output with each Mach-O member replaced by
    sign(bytes), keeping every other member and header as it was."""
    with tarfile.open(source) as tar, open(output, "wb") as raw, \
            gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed, \
            tarfile.open(fileobj=compressed, mode="w", format=tar.format) as out:
        for member in tar:
            data = tar.extractfile(member).read() if member.isfile() else None
            if data is not None and data[:4] in MACHO_MAGIC and not developer_id_signed(data):
                data = sign(member.name, data)
                member.size = len(data)
            out.addfile(member, io.BytesIO(data) if data is not None else None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--developer-id", required=True, help="Developer ID Application certificate and key (.p12)")
    parser.add_argument("--password-file", help="file holding the .p12 password; asked for when absent")
    parser.add_argument("--distribution", default=os.path.join(DESKTOP, "distribution", "darwin-arm64.json"))
    parser.add_argument("--dir", default=os.environ.get("LINGER_NATIVE_POSTGRES_DIR")
                        or os.path.expanduser("~/.cache/linger-desktop"))
    parser.add_argument("--rcodesign", default=shutil.which("rcodesign") or "rcodesign")
    args = parser.parse_args()
    with open(args.distribution) as source:
        distribution = json.load(source)
    pending = []
    for source in [*distribution["nativeSources"], *distribution.get("voiceTools", [])]:
        if "file" not in source:
            continue
        path = os.path.join(args.dir, os.path.basename(source["file"]))
        if not os.path.exists(path) or os.path.getsize(path) != source["bytes"] or sha256(path) != source["sha256"]:
            target = f"{distribution['platform']}-{distribution['arch']}"
            sys.exit(f"{path} does not match {args.distribution}; fetch it first "
                     f"(scripts/ci/desktop-release.sh fetch-native {target})")
        if unsigned_archive_files(path):
            if source["sha256"] not in source["file"]:
                sys.exit(f"{source['file']} does not carry its sha256 in its name")
            pending.append((source, path))
        else:
            print(f"{os.path.basename(path)} is already signed")
    if not pending:
        return
    with tempfile.TemporaryDirectory() as work:
        password = args.password_file
        if password is None:
            password = os.path.join(work, "password")
            with open(os.open(password, os.O_WRONLY | os.O_CREAT, 0o600), "w") as out:
                out.write(getpass.getpass(f"Password of {args.developer_id}: "))

        def sign(name, data):
            binary = os.path.join(work, "binary")
            with open(binary, "wb") as out:
                out.write(data)
            subprocess.run([args.rcodesign, "sign", "--p12-file", args.developer_id,
                            "--p12-password-file", password, "--for-notarization",
                            "--code-signature-flags", "runtime", binary],
                           check=True, stdout=subprocess.DEVNULL)
            with open(binary, "rb") as signed:
                data = signed.read()
            if not developer_id_signed(data):
                sys.exit(f"rcodesign left {name} without a Developer ID signature")
            print(f"signed {name}", flush=True)
            return data

        for source, path in pending:
            staged = os.path.join(work, "archive.tar.gz")
            sign_archive(path, staged, sign)
            digest = sha256(staged)
            name = os.path.basename(source["file"]).replace(source["sha256"], digest)
            shutil.move(staged, os.path.join(args.dir, name))
            source.update(file=os.path.join(os.path.dirname(source["file"]), name),
                          sha256=digest, bytes=os.path.getsize(os.path.join(args.dir, name)))
            print(f"{os.path.join(args.dir, name)} {source['bytes']} sha256={digest}", flush=True)
    with open(args.distribution, "w") as out:
        out.write(json.dumps(distribution, indent=2) + "\n")
    print(f"updated {args.distribution}; upload the new archives beside the old ones before tagging")


if __name__ == "__main__":
    main()
