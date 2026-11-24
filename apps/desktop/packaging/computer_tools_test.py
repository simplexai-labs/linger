"""Checks of the Computer tools every desktop package must carry.

    python3 -m unittest discover -s apps/desktop/packaging -p '*_test.py'
"""
import hashlib
import importlib.util
import io
import json
import os
import plistlib
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

import archive
import computer_tools
import native_bundle

HERE = os.path.dirname(os.path.abspath(__file__))
MACHO = b"\xcf\xfa\xed\xfe" + b"\0" * 28
PLAYWRIGHT_ENTRY = "node_modules/@playwright/mcp/cli.js"
PI_EXTENSION = "extensions/pi-mcp.mjs"
# A native Windows checkout cannot set POSIX executable bits on fixtures.
HOST_FIXTURE_TARGET = "win32-x64" if os.name == "nt" else "linux-x64"
# The pins the shared validator holds the manifest to.
FROZEN = json.loads(subprocess.check_output([
    "node", "--input-type=module", "-e",
    "import { COMPUTER_TOOL_VERSIONS as versions, CUA_ARCHIVES as cua, QUICKJS_TOOL_ASSETS as quickjs } from "
    + json.dumps("file://" + os.path.join(HERE, "..", "..", "..", "scripts", "computer-tool-bundle.mjs"))
    + "; console.log(JSON.stringify({ versions, cua, quickjs }))",
]))


def sha256(path):
    with open(path, "rb") as source:
        return hashlib.sha256(source.read()).hexdigest()


def stage(root, target):
    """A resources/ folder holding tools laid out as stage-computer-tools.mjs writes them."""
    tools = os.path.join(root, "cli", "computer-tools")
    files = {
        PLAYWRIGHT_ENTRY: b"console.log('playwright')\n",
        PI_EXTENSION: b"export default {}\n",
        "node_modules/native/prebuilt.node": MACHO,
    }
    cua = FROZEN["cua"].get(target, {})
    for relative in FROZEN["quickjs"]:
        files[relative] = b"engine"
    for relative in cua.get("required", []):
        files[relative] = MACHO + relative.encode()
    assets = []
    for relative in sorted(files):
        path = os.path.join(tools, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as out:
            out.write(files[relative])
        assets.append({"path": relative, "size_bytes": len(files[relative]),
                       "sha256": sha256(path), "mode": 0o644})
    # JSON.stringify of the asset list, as bundle-computer-tools.mjs digests it.
    digest = hashlib.sha256(json.dumps(assets, separators=(",", ":")).encode()).hexdigest()
    manifest = {"schema_version": 1, "versions": FROZEN["versions"], "target": target,
                "playwright_entry": PLAYWRIGHT_ENTRY, "pi_extension": PI_EXTENSION,
                "cua_entry": cua.get("entry", ""), "packages": [],
                "assets": assets, "artifact_sha256": digest}
    with open(os.path.join(tools, "manifest.json"), "w") as out:
        json.dump(manifest, out)
    node = os.path.join(root, computer_tools.node_path(target))
    os.makedirs(os.path.dirname(node))
    with open(node, "wb") as out:
        out.write(b"node")
    os.chmod(node, 0o755)
    return tools


class ComputerToolsTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)

    def resources(self, target="linux-x64"):
        resources = os.path.join(self.root, target, "resources")
        return resources, stage(resources, target)

    def test_accepts_the_staged_tools_of_every_shipped_target(self):
        for target in ("darwin-arm64", "linux-x64", "win32-x64"):
            with self.subTest(target=target):
                if os.name == "nt" and not target.startswith("win32-"):
                    self.skipTest("Windows cannot make POSIX executable fixture files")
                resources, _ = self.resources(target)
                computer_tools.verify(resources, target)

    def test_rejects_resources_without_the_tools(self):
        resources = os.path.join(self.root, "resources")
        os.makedirs(os.path.join(resources, "computer"))
        with self.assertRaisesRegex(computer_tools.Invalid, "manifest.json"):
            computer_tools.verify(resources, "linux-x64")
        with self.assertRaises(SystemExit):
            computer_tools.check(resources, "linux-x64")

    def test_rejects_changed_unlisted_or_missing_files(self):
        resources, tools = self.resources()
        with open(os.path.join(tools, PI_EXTENSION), "ab") as out:
            out.write(b"//")
        with self.assertRaisesRegex(computer_tools.Invalid, "do not match their manifest"):
            computer_tools.verify(resources, "linux-x64")

        resources, tools = self.resources("win32-x64")
        with open(os.path.join(tools, "extra.js"), "w") as out:
            out.write("1")
        with self.assertRaisesRegex(computer_tools.Invalid, "do not match their manifest"):
            computer_tools.verify(resources, "win32-x64")

        resources, _ = self.resources("darwin-arm64")
        os.remove(os.path.join(resources, "runtime", "bin", "node"))
        with self.assertRaisesRegex(computer_tools.Invalid, "missing or not executable"):
            computer_tools.verify(resources, "darwin-arm64")

    def test_rejects_tools_for_another_target(self):
        resources, _ = self.resources("darwin-arm64")
        with self.assertRaisesRegex(computer_tools.Invalid, "Invalid Computer tool manifest"):
            computer_tools.verify(resources, "darwin-x64")

    def test_copy_places_the_staged_tools_next_to_the_daemon_folder(self):
        staged = os.path.join(self.root, "dist", "computer-tools")
        target = HOST_FIXTURE_TARGET
        stage(os.path.join(staged, target), target)
        resources = os.path.join(self.root, "app", "resources")
        os.makedirs(resources)
        computer_tools.copy(resources, target, staged=staged)
        computer_tools.verify(resources, target)
        with self.assertRaises(SystemExit):
            computer_tools.copy(resources, "darwin-arm64", staged=staged)

    def test_refresh_records_only_resigned_macho_files(self):
        resources, tools = self.resources("darwin-arm64")
        for relative in ("node_modules/native/prebuilt.node", "cua/cua-driver"):
            with open(os.path.join(tools, relative), "ab") as out:
                out.write(b"signature")
        computer_tools.refresh_signed(resources, kept=["cua/cua-driver"])
        # The vendor-signed driver must come back unchanged.
        with self.assertRaisesRegex(computer_tools.Invalid, "do not match their manifest"):
            computer_tools.verify(resources, "darwin-arm64")

        target = HOST_FIXTURE_TARGET
        resources, tools = self.resources(target)
        with open(os.path.join(tools, "node_modules/native/prebuilt.node"), "ab") as out:
            out.write(b"signature")
        computer_tools.refresh_signed(resources)
        computer_tools.verify(resources, target)
        with open(os.path.join(tools, PLAYWRIGHT_ENTRY), "ab") as out:
            out.write(b"//")
        computer_tools.refresh_signed(resources)
        with self.assertRaisesRegex(computer_tools.Invalid, "do not match their manifest"):
            computer_tools.verify(resources, target)

    def test_finished_archives_must_hold_the_tools(self):
        resources, _ = self.resources("linux-x64")
        app = os.path.dirname(resources)
        archive = os.path.join(self.root, "Linger.tar.gz")
        with tarfile.open(archive, "w:gz") as out:
            out.add(app, arcname="Linger")
        self.assertEqual(computer_tools.verify_archive(archive, "Linger/resources/", "linux-x64"),
                         3 + len(FROZEN["quickjs"]))

        resources, _ = self.resources("win32-x64")
        archive = os.path.join(self.root, "Linger.zip")
        with zipfile.ZipFile(archive, "w") as out:
            for root, _, files in os.walk(resources):
                for name in files:
                    path = os.path.join(root, name)
                    out.write(path, "Linger/resources/" + os.path.relpath(path, resources))
        self.assertEqual(computer_tools.verify_archive(archive, "Linger/resources/", "win32-x64"),
                         4 + len(FROZEN["quickjs"]))

        bare = os.path.join(self.root, "bare.tar.gz")
        with tarfile.open(bare, "w:gz") as out:
            info = tarfile.TarInfo("Linger/resources/computer/linger-computer-daemon")
            info.size = 4
            out.addfile(info, io.BytesIO(b"bin\n"))
        with self.assertRaisesRegex(computer_tools.Invalid, "has no Linger/resources/cli"):
            computer_tools.verify_archive(bare, "Linger/resources/", "linux-x64")
        with self.assertRaises(SystemExit):
            computer_tools.check_archive(bare, "Linger/resources/", "linux-x64")


class MacSigningTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("mac_package", os.path.join(HERE, "mac", "package.py"))
        self.mac = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mac)

    def test_tools_node_gets_the_node_entitlements(self):
        self.assertTrue(self.mac.bundled_node("Contents/Resources/runtime/bin/node"))
        self.assertFalse(self.mac.bundled_node("Contents/Resources/computer/linger-computer-daemon"))

    def test_cua_app_keeps_its_vendor_signature(self):
        app = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, app)
        args = self.mac.Signing("rcodesign").app_args(app)
        self.assertIn("Contents/Resources/cli/computer-tools/cua/CuaDriver.app",
                      args[args.index("--exclude") + 1])

    def test_npm_scope_paths_name_each_architecture(self):
        app = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, app)
        modules = os.path.join(app, "Contents", "Resources", "node_modules")
        thin = os.path.join(modules, "@img", "sharp", "sharp.node")
        fat = os.path.join(modules, "@cua", "driver")
        plain = os.path.join(modules, "canvas", "skia.node")
        for path, data in ((thin, MACHO), (fat, b"\xca\xfe\xba\xbe\0\0\0\2" + b"\0" * 24), (plain, MACHO)):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as out:
                out.write(data)
        args = self.mac.Signing("rcodesign", "id.p12", "id.password").app_args(app)
        flags = [args[i + 1] for i, arg in enumerate(args) if arg == "--code-signature-flags"]
        self.assertEqual(flags, [
            "Contents/Resources/node_modules/@cua/driver@0:runtime",
            "Contents/Resources/node_modules/@cua/driver@1:runtime",
            "Contents/Resources/node_modules/@img/sharp/sharp.node@0:runtime",
            "Contents/Resources/node_modules/canvas/skia.node:runtime",
        ])

    def test_app_and_helpers_may_ask_for_the_microphone(self):
        # Under the hardened runtime macOS gives an app without audio-input a
        # silent microphone and never asks; the prompt shows our text.
        app = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, app)
        main = os.path.join(app, "Contents", "MacOS", "Linger")
        helper = os.path.join(app, "Contents", "Frameworks", "Linger Helper (Renderer).app",
                              "Contents", "MacOS", "Linger Helper (Renderer)")
        for path in (main, helper):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as out:
                out.write(MACHO)
        args = self.mac.Signing("rcodesign", "id.p12", "id.password").app_args(app)
        given = {args[i + 1] for i, arg in enumerate(args) if arg == "--entitlements-xml-file"}
        entitlements = os.path.join(HERE, "mac", "entitlements.plist")
        self.assertEqual(given, {
            f"Contents/MacOS/Linger:{entitlements}",
            f"Contents/Frameworks/Linger Helper (Renderer).app/Contents/MacOS/Linger Helper (Renderer):{entitlements}",
        })
        with open(entitlements, "rb") as source:
            self.assertIs(plistlib.load(source).get("com.apple.security.device.audio-input"), True)
        usage = self.mac.PRIVACY_USAGE["NSMicrophoneUsageDescription"]
        self.assertIn("Linger", usage)
        self.assertNotEqual(usage, "This app needs access to the microphone")

    @staticmethod
    def signed_macho(flags, cms):
        """A thin Mach-O with one LC_CODE_SIGNATURE: a CodeDirectory with flags
        and a CMS blob of cms bytes."""
        be = lambda value: value.to_bytes(4, "big")  # noqa: E731
        directory = be(0xFADE0C02) + be(16) + be(0x20400) + be(flags)
        blob = be(0xFADE0B01) + be(8 + len(cms)) + cms
        superblob = be(0xFADE0CC0) + be(28 + len(directory) + len(blob)) + be(2) \
            + be(0) + be(28) + be(0x10000) + be(28 + len(directory)) + directory + blob
        command = (0x1D).to_bytes(4, "little") + (16).to_bytes(4, "little") \
            + (48).to_bytes(4, "little") + len(superblob).to_bytes(4, "little")
        header = b"\xcf\xfa\xed\xfe" + b"\0" * 12 + (1).to_bytes(4, "little") + b"\0" * 12
        return header + command + superblob

    def test_developer_id_signature_needs_a_certificate_and_the_hardened_runtime(self):
        self.assertTrue(self.mac.developer_id_signed(self.signed_macho(0x10000, b"cms")))
        self.assertFalse(self.mac.developer_id_signed(self.signed_macho(0x10002, b"")))  # linker ad-hoc
        self.assertFalse(self.mac.developer_id_signed(self.signed_macho(0, b"cms")))  # no hardened runtime
        self.assertFalse(self.mac.developer_id_signed(MACHO))  # no signature at all

    def test_bundled_archives_without_developer_id_stop_the_build(self):
        app = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, app)
        native = os.path.join(app, self.mac.NATIVE)
        os.makedirs(native)

        def archive(name, data):
            with tarfile.open(os.path.join(native, name), "w:gz") as tar:
                for member, body in (("./bin/tool", data), ("./README", b"text")):
                    info = tarfile.TarInfo(member)
                    info.size = len(body)
                    tar.addfile(info, io.BytesIO(body))

        archive("signed.tar.gz", self.signed_macho(0x10000, b"cms"))
        self.mac.check_bundled_archives(app)
        archive("ad-hoc.tar.gz", self.signed_macho(0x10002, b""))
        with self.assertRaises(SystemExit) as stopped:
            self.mac.check_bundled_archives(app)
        self.assertIn("ad-hoc.tar.gz holds 1 Mach-O files", str(stopped.exception))

    def test_signing_an_archive_replaces_only_unsigned_macho_members(self):
        spec = importlib.util.spec_from_file_location(
            "sign_native_archives", os.path.join(HERE, "mac", "sign_native_archives.py"))
        signer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(signer)
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        source = os.path.join(root, "in.tar.gz")
        signed = self.signed_macho(0x10000, b"cms")
        with tarfile.open(source, "w:gz") as tar:
            for name, body in (("./bin/ffmpeg", MACHO), ("./bin/done", signed), ("./LICENSE", b"text")):
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(body), 0o755
                tar.addfile(info, io.BytesIO(body))
            link = tarfile.TarInfo("./bin/ff")
            link.type, link.linkname = tarfile.SYMTYPE, "ffmpeg"
            tar.addfile(link)
        calls = []

        def sign(name, data):
            calls.append(name)
            return signed

        output = os.path.join(root, "out.tar.gz")
        signer.sign_archive(source, output, sign)
        self.assertEqual(calls, ["./bin/ffmpeg"])
        with tarfile.open(output) as tar:
            members = {member.name: member for member in tar}
            self.assertEqual(tar.extractfile("./bin/ffmpeg").read(), signed)
            self.assertEqual(members["./bin/ffmpeg"].mode, 0o755)
            self.assertEqual(tar.extractfile("./LICENSE").read(), b"text")
            self.assertEqual(members["./bin/ff"].linkname, "ffmpeg")
        self.assertEqual(self.mac.unsigned_archive_files(output), [])

    def test_emit_outputs_notarizes_dmg_once_then_staples_app_for_update_archive(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        stage = os.path.join(root, "stage")
        app = os.path.join(stage, "Linger.app")
        out_dir = os.path.join(root, "out")
        os.makedirs(os.path.join(app, "Contents"))
        os.makedirs(out_dir)
        with open(os.path.join(app, "Contents", "Info.plist"), "wb") as out:
            out.write(b"plist")

        events = []

        class FakeSigning:
            notary_key = "notary.json"

            def sign_dmg(self, dmg):
                events.append(("sign_dmg", os.path.basename(dmg)))

            def notarize(self, path):
                events.append(("notarize", os.path.basename(path)))

            def staple(self, path):
                events.append(("staple", os.path.basename(path)))

        orig_build_dmg = self.mac.build_dmg
        orig_update_archive = self.mac.update_archive
        orig_check_archive = self.mac.computer_tools.check_archive

        def fake_build_dmg(dmg_stage, dmg_workdir, output, volume_name):
            self.assertEqual(dmg_stage, stage)
            self.assertEqual(dmg_workdir, root)
            events.append(("build_dmg", os.path.basename(output)))
            with open(output, "wb") as out:
                out.write(b"dmg")

        def fake_update_archive(target_app, output):
            self.assertEqual(target_app, app)
            events.append(("update_archive", os.path.basename(output)))
            with open(output, "wb") as out:
                out.write(b"tar.gz")

        def fake_check_archive(archive_path, prefix, target):
            events.append(("check_archive", os.path.basename(archive_path), target))

        try:
            self.mac.build_dmg = fake_build_dmg
            self.mac.update_archive = fake_update_archive
            self.mac.computer_tools.check_archive = fake_check_archive
            self.mac.emit_outputs(stage, app, root, out_dir, "1.2.3", "arm64", FakeSigning(), True)
        finally:
            self.mac.build_dmg = orig_build_dmg
            self.mac.update_archive = orig_update_archive
            self.mac.computer_tools.check_archive = orig_check_archive

        self.assertEqual(events, [
            ("build_dmg", "Linger-1.2.3-arm64.dmg"),
            ("sign_dmg", "Linger-1.2.3-arm64.dmg"),
            ("notarize", "Linger-1.2.3-arm64.dmg"),
            ("staple", "Linger.app"),
            ("update_archive", "Linger-1.2.3-arm64.app.tar.gz"),
            ("check_archive", "Linger-1.2.3-arm64.app.tar.gz", "darwin-arm64"),
        ])

    def test_signing_staple_retries_transient_lookup_errors(self):
        calls = []
        orig_run = self.mac.run

        def fake_run(*args, **kwargs):
            calls.append(args)
            if len(calls) < 3:
                raise subprocess.CalledProcessError(1, args)

        try:
            self.mac.run = fake_run
            # Without a notary key, staple is a no-op.
            self.mac.Signing("rcodesign").staple("/tmp/Linger.app", attempts=3, delay_seconds=0)
            self.assertEqual(calls, [])
            # With a notary key, transient CloudKit ticket lookup errors retry.
            signing = self.mac.Signing("rcodesign", "id.p12", "id.password", "notary.json")
            signing.staple("/tmp/Linger.app", attempts=3, delay_seconds=0)
        finally:
            self.mac.run = orig_run

        self.assertEqual(calls, [
            ("rcodesign", "staple", "/tmp/Linger.app"),
            ("rcodesign", "staple", "/tmp/Linger.app"),
            ("rcodesign", "staple", "/tmp/Linger.app"),
        ])

    def test_native_bundle_refresh_rehashes_signed_macho_and_keeps_untouched_files(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        runtime_dir = os.path.join(root, "runtime-darwin-arm64")
        runtime_files_dir = os.path.join(runtime_dir, "runtime")
        node_bin = os.path.join(runtime_dir, "node", "bin", "node")
        os.makedirs(runtime_files_dir)
        os.makedirs(os.path.dirname(node_bin))

        addon = os.path.join(runtime_files_dir, "addon.node")
        script_file = os.path.join(runtime_files_dir, "index.js")
        with open(addon, "wb") as out:
            out.write(MACHO)
        with open(script_file, "wb") as out:
            out.write(b"export const ok = true;\n")
        with open(node_bin, "wb") as out:
            out.write(MACHO)

        files_json = os.path.join(runtime_files_dir, "files.json")
        with open(files_json, "w") as out:
            json.dump({
                "schema": 1,
                "target": "darwin-arm64",
                "files": {
                    "addon.node": {"bytes": os.path.getsize(addon), "sha256": sha256(addon)},
                    "index.js": {"bytes": os.path.getsize(script_file), "sha256": sha256(script_file)},
                },
            }, out)
        with open(os.path.join(runtime_dir, "manifest.json"), "w") as out:
            json.dump({
                "schema": 1,
                "target": "darwin-arm64",
                "layout": "directory",
                "directory": {"file": "runtime/files.json", "bytes": os.path.getsize(files_json), "sha256": sha256(files_json)},
                "node": {"file": "node/bin/node", "bytes": os.path.getsize(node_bin), "sha256": sha256(node_bin)},
            }, out)

        # Simulate rcodesign rewriting only Mach-O binaries.
        signed_addon = self.signed_macho(0x10000, b"cms")
        with open(addon, "wb") as out:
            out.write(signed_addon)
        with open(node_bin, "wb") as out:
            out.write(signed_addon)

        native_bundle.refresh(root, "darwin-arm64")
        native_bundle.check_runtime("darwin-arm64", native=root)
        with open(files_json) as source:
            refreshed = json.load(source)["files"]
        self.assertEqual(refreshed["addon.node"]["sha256"], sha256(addon))
        self.assertEqual(refreshed["index.js"]["sha256"], sha256(script_file))


class ArchiveHelperTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)

    def test_tar_gz_preserves_symlinks_and_applies_root_owner_option(self):
        bundle = os.path.join(self.root, "Linger")
        os.makedirs(bundle)
        file_path = os.path.join(bundle, "hello.txt")
        with open(file_path, "wb") as out:
            out.write(b"linger\n")
        os.symlink("hello.txt", os.path.join(bundle, "link.txt"))

        owned = os.path.join(self.root, "owned.tar.gz")
        archive.tar_gz(self.root, "Linger", owned, root_owner=True)
        with tarfile.open(owned, "r:gz") as tf:
            members = {m.name: m for m in tf.getmembers()}
            self.assertEqual(members["Linger/hello.txt"].uid, 0)
            self.assertEqual(members["Linger/hello.txt"].gid, 0)
            self.assertTrue(members["Linger/link.txt"].issym())
            self.assertEqual(members["Linger/link.txt"].linkname, "hello.txt")

        plain = os.path.join(self.root, "plain.tar.gz")
        archive.tar_gz(self.root, "Linger", plain)
        self.assertEqual(archive.sha256(plain), sha256(plain))


if __name__ == "__main__":
    unittest.main()
