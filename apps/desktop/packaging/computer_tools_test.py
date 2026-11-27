"""Checks of the Computer tools every desktop package must carry.

    python3 -m unittest discover -s apps/desktop/packaging -p '*_test.py'
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest import mock
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


def pi_entry(target):
    return "bin/pi.exe" if target.startswith("win32-") else "bin/pi"


def stage(root, target):
    """A resources/ folder holding tools laid out as stage-computer-tools.mjs writes them."""
    tools = os.path.join(root, "cli", "computer-tools")
    pi = pi_entry(target)
    files = {
        PLAYWRIGHT_ENTRY: b"console.log('playwright')\n",
        PI_EXTENSION: b"export default {}\n",
        pi: b"#!/bin/sh\n" if not target.startswith("win32-") else b"MZ",
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
        mode = 0o755 if relative == pi and not target.startswith("win32-") else 0o644
        if mode == 0o755:
            os.chmod(path, 0o755)
        assets.append({"path": relative, "size_bytes": len(files[relative]),
                       "sha256": sha256(path), "mode": mode})
    # JSON.stringify of the asset list, as bundle-computer-tools.mjs digests it.
    digest = hashlib.sha256(json.dumps(assets, separators=(",", ":")).encode()).hexdigest()
    manifest = {"schema_version": 1, "versions": FROZEN["versions"], "target": target,
                "playwright_entry": PLAYWRIGHT_ENTRY, "pi_extension": PI_EXTENSION,
                "pi_entry": pi, "cua_entry": cua.get("entry", ""), "packages": [],
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
        self._resource_seq = 0
        self.addCleanup(shutil.rmtree, self.root)

    def resources(self, target="linux-x64"):
        self._resource_seq += 1
        resources = os.path.join(self.root, f"{target}-{self._resource_seq}", "resources")
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
        target = HOST_FIXTURE_TARGET
        resources, tools = self.resources(target)
        with open(os.path.join(tools, PI_EXTENSION), "ab") as out:
            out.write(b"//")
        with self.assertRaisesRegex(computer_tools.Invalid, "do not match their manifest"):
            computer_tools.verify(resources, target)

        resources, tools = self.resources("win32-x64")
        with open(os.path.join(tools, "extra.js"), "w") as out:
            out.write("1")
        with self.assertRaisesRegex(computer_tools.Invalid, "do not match their manifest"):
            computer_tools.verify(resources, "win32-x64")

        resources, _ = self.resources(target)
        os.remove(os.path.join(resources, computer_tools.node_path(target)))
        with self.assertRaisesRegex(computer_tools.Invalid, "missing or not executable"):
            computer_tools.verify(resources, target)

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
                         4 + len(FROZEN["quickjs"]))

        resources, _ = self.resources("win32-x64")
        archive = os.path.join(self.root, "Linger.zip")
        with zipfile.ZipFile(archive, "w") as out:
            for root, _, files in os.walk(resources):
                for name in files:
                    path = os.path.join(root, name)
                    out.write(path, "Linger/resources/" + os.path.relpath(path, resources))
        self.assertEqual(computer_tools.verify_archive(archive, "Linger/resources/", "win32-x64"),
                         5 + len(FROZEN["quickjs"]))

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

    def _emit_fixture(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        stage = os.path.join(root, "stage")
        app = os.path.join(stage, "Linger.app")
        out_dir = os.path.join(root, "out")
        os.makedirs(os.path.join(app, "Contents"))
        os.makedirs(out_dir)
        with open(os.path.join(app, "Contents", "Info.plist"), "wb") as out:
            out.write(b"plist")
        return root, stage, app, out_dir

    def _stub_emit_tools(self, fake_build_dmg, fake_update_archive, fake_check_archive):
        orig_build_dmg = self.mac.build_dmg
        orig_update_archive = self.mac.update_archive
        orig_check_archive = self.mac.computer_tools.check_archive

        def restore():
            self.mac.build_dmg = orig_build_dmg
            self.mac.update_archive = orig_update_archive
            self.mac.computer_tools.check_archive = orig_check_archive

        self.addCleanup(restore)
        self.mac.build_dmg = fake_build_dmg
        self.mac.update_archive = fake_update_archive
        self.mac.computer_tools.check_archive = fake_check_archive

    def test_emit_outputs_notarizes_and_staples_app_before_parallel_dmg_and_update(self):
        root, stage, app, out_dir = self._emit_fixture()
        ticket = os.path.join(app, "Contents", "CodeResources")
        lock = threading.Lock()
        events = []

        class FakeSigning:
            notary_key = "notary.json"

            def sign_dmg(self, dmg):
                with lock:
                    events.append(("sign_dmg", os.path.basename(dmg)))

            def notarize(self, path):
                with lock:
                    events.append(("notarize", os.path.basename(path)))
                if path == app:
                    with open(ticket, "wb") as out:
                        out.write(b"ticket")

        def fake_build_dmg(dmg_stage, dmg_workdir, output, volume_name):
            self.assertEqual(dmg_stage, stage)
            self.assertEqual(dmg_workdir, root)
            self.assertTrue(os.path.isfile(ticket))
            self.assertGreater(os.path.getsize(ticket), 0)
            with lock:
                events.append(("build_dmg", os.path.basename(output)))
            with open(output, "wb") as out:
                out.write(b"dmg")

        def fake_update_archive(target_app, output):
            self.assertEqual(target_app, app)
            self.assertTrue(os.path.isfile(ticket))
            self.assertGreater(os.path.getsize(ticket), 0)
            with lock:
                events.append(("update_archive", os.path.basename(output)))
            with open(output, "wb") as out:
                out.write(b"tar.gz")

        def fake_check_archive(archive_path, prefix, target):
            self.assertEqual(prefix, "Linger.app/Contents/Resources/")
            with lock:
                events.append(("check_archive", os.path.basename(archive_path), target))

        self._stub_emit_tools(fake_build_dmg, fake_update_archive, fake_check_archive)
        with contextlib.redirect_stdout(io.StringIO()):
            self.mac.emit_outputs(stage, app, root, out_dir, "1.2.3", "arm64", FakeSigning(), True)

        notarize_app = events.index(("notarize", "Linger.app"))
        build_dmg = events.index(("build_dmg", "Linger-1.2.3-arm64.dmg"))
        sign_dmg = events.index(("sign_dmg", "Linger-1.2.3-arm64.dmg"))
        notarize_dmg = events.index(("notarize", "Linger-1.2.3-arm64.dmg"))
        pack_update = events.index(("update_archive", "Linger-1.2.3-arm64.app.tar.gz"))
        check_update = events.index(("check_archive", "Linger-1.2.3-arm64.app.tar.gz", "darwin-arm64"))

        self.assertLess(notarize_app, build_dmg)
        self.assertLess(notarize_app, pack_update)
        self.assertLess(build_dmg, sign_dmg)
        self.assertLess(sign_dmg, notarize_dmg)
        self.assertLess(pack_update, check_update)
        self.assertEqual(len(events), 6)
        self.assertTrue(os.path.isfile(os.path.join(out_dir, "Linger-1.2.3-arm64.dmg")))
        self.assertTrue(os.path.isfile(os.path.join(out_dir, "Linger-1.2.3-arm64.app.tar.gz")))

    def test_emit_outputs_fails_closed_if_notarized_app_lacks_stapled_ticket(self):
        for label, ticket_bytes in (("missing", None), ("empty", b"")):
            with self.subTest(ticket=label):
                root, stage, app, out_dir = self._emit_fixture()
                ticket = os.path.join(app, "Contents", "CodeResources")
                events = []

                class FakeSigning:
                    notary_key = "notary.json"

                    def sign_dmg(self, dmg):
                        events.append(("sign_dmg", os.path.basename(dmg)))

                    def notarize(self, path):
                        events.append(("notarize", os.path.basename(path)))
                        if path == app and ticket_bytes is not None:
                            with open(ticket, "wb") as out:
                                out.write(ticket_bytes)

                def fake_build_dmg(dmg_stage, dmg_workdir, output, volume_name):
                    events.append(("build_dmg", os.path.basename(output)))

                def fake_update_archive(target_app, output):
                    events.append(("update_archive", os.path.basename(output)))

                def fake_check_archive(archive_path, prefix, target):
                    events.append(("check_archive", os.path.basename(archive_path), target))

                self._stub_emit_tools(fake_build_dmg, fake_update_archive, fake_check_archive)
                with self.assertRaises(SystemExit) as stopped:
                    self.mac.emit_outputs(stage, app, root, out_dir, "1.2.3", "arm64", FakeSigning(), True)
                self.assertIn("CodeResources", str(stopped.exception))
                self.assertEqual(events, [("notarize", "Linger.app")])
                self.assertEqual(os.listdir(out_dir), [])

    def test_emit_outputs_without_notary_key_and_without_update_archive(self):
        # Ad-hoc local build: no notary_key and no update archive.
        root, stage, app, out_dir = self._emit_fixture()
        events = []

        def fake_build_dmg(dmg_stage, dmg_workdir, output, volume_name):
            events.append(("build_dmg", os.path.basename(output)))
            with open(output, "wb") as out:
                out.write(b"dmg")

        def fake_update_archive(target_app, output):
            events.append(("update_archive", os.path.basename(output)))

        def fake_check_archive(archive_path, prefix, target):
            events.append(("check_archive", os.path.basename(archive_path), target))

        self._stub_emit_tools(fake_build_dmg, fake_update_archive, fake_check_archive)
        with contextlib.redirect_stdout(io.StringIO()):
            self.mac.emit_outputs(stage, app, root, out_dir, "1.2.3", "arm64",
                                  self.mac.Signing("rcodesign"), False)
        self.assertFalse(os.path.exists(os.path.join(app, "Contents", "CodeResources")))
        self.assertEqual(events, [("build_dmg", "Linger-1.2.3-arm64.dmg")])
        self.assertTrue(os.path.isfile(os.path.join(out_dir, "Linger-1.2.3-arm64.dmg")))
        self.assertFalse(os.path.exists(os.path.join(out_dir, "Linger-1.2.3-arm64.app.tar.gz")))

        # Notarized build without --update-archive still notarizes/staples Linger.app first.
        root, stage, app, out_dir = self._emit_fixture()
        ticket = os.path.join(app, "Contents", "CodeResources")
        events = []

        class FakeSigning:
            notary_key = "notary.json"

            def sign_dmg(self, dmg):
                events.append(("sign_dmg", os.path.basename(dmg)))

            def notarize(self, path):
                events.append(("notarize", os.path.basename(path)))
                if path == app:
                    with open(ticket, "wb") as out:
                        out.write(b"ticket")

        def fake_notarized_build_dmg(dmg_stage, dmg_workdir, output, volume_name):
            self.assertTrue(os.path.isfile(ticket))
            self.assertGreater(os.path.getsize(ticket), 0)
            events.append(("build_dmg", os.path.basename(output)))
            with open(output, "wb") as out:
                out.write(b"dmg")

        self._stub_emit_tools(fake_notarized_build_dmg, fake_update_archive, fake_check_archive)
        with contextlib.redirect_stdout(io.StringIO()):
            self.mac.emit_outputs(stage, app, root, out_dir, "1.2.3", "arm64", FakeSigning(), False)
        self.assertEqual(events, [
            ("notarize", "Linger.app"),
            ("build_dmg", "Linger-1.2.3-arm64.dmg"),
            ("sign_dmg", "Linger-1.2.3-arm64.dmg"),
            ("notarize", "Linger-1.2.3-arm64.dmg"),
        ])
        self.assertTrue(os.path.isfile(os.path.join(out_dir, "Linger-1.2.3-arm64.dmg")))
        self.assertFalse(os.path.exists(os.path.join(out_dir, "Linger-1.2.3-arm64.app.tar.gz")))

    def _stub_notarize_calls(self, on_run, on_capture, on_staple):
        orig_run = self.mac.run
        orig_capture = self.mac.run_capture
        orig_staple = self.mac.Signing.staple

        def restore():
            self.mac.run = orig_run
            self.mac.run_capture = orig_capture
            self.mac.Signing.staple = orig_staple

        self.addCleanup(restore)
        self.mac.run = on_run
        self.mac.run_capture = on_capture
        self.mac.Signing.staple = on_staple

    def test_run_capture_streams_merged_output_and_keeps_log_stdout_clean(self):
        captured_stderr = io.StringIO()
        with contextlib.redirect_stderr(captured_stderr):
            output = self.mac.run_capture(
                sys.executable,
                "-c",
                "import sys; sys.stdout.write('out\\n'); sys.stderr.buffer.write(b'err \\xff\\n')",
                merge_stderr=True,
                stream=True,
            )
        self.assertIn("out\n", output)
        self.assertIn("err \ufffd\n", output)
        self.assertEqual(captured_stderr.getvalue(), output)

        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(subprocess.CalledProcessError) as failed:
                self.mac.run_capture(
                    sys.executable,
                    "-c",
                    "import sys; sys.stderr.write('boom\\n'); sys.exit(2)",
                    merge_stderr=True,
                    stream=True,
                )
        self.assertEqual(failed.exception.returncode, 2)
        self.assertIn("boom", failed.exception.output)

        # Unmerged capture leaves stderr out of JSON stdout while keeping stderr inherited.
        with tempfile.TemporaryFile(mode="w+b") as stderr_file:
            saved_stderr = os.dup(2)
            try:
                sys.stderr.flush()
                os.dup2(stderr_file.fileno(), 2)
                stdout = self.mac.run_capture(
                    sys.executable,
                    "-c",
                    "import sys; sys.stderr.write('warn! ignored\\n'); sys.stdout.write('{\"status\":\"Accepted\"}\\n')",
                )
            finally:
                os.dup2(saved_stderr, 2)
                os.close(saved_stderr)
            stderr_file.seek(0)
            inherited_stderr = stderr_file.read().decode("utf-8")
        self.assertEqual(json.loads(stdout), {"status": "Accepted"})
        self.assertIn("warn! ignored", inherited_stderr)

    def test_signing_notarize_waits_then_staples_and_handles_failures(self):
        submission_id = "12345678-1234-5678-9abc-def012345678"
        calls = []

        def fake_run(*args, **kwargs):
            calls.append(("run", args))

        def fake_capture(*args, merge_stderr=False, stream=False):
            calls.append(("capture", args, merge_stderr, stream))
            if args[1] == "notary-submit":
                return f"uploading...\ncreated submission ID: {submission_id}\n"
            if args[1] == "notary-log":
                return json.dumps({"status": "Accepted", "id": submission_id})
            raise AssertionError(f"unexpected command: {args}")

        def fake_staple(signing_self, path):
            calls.append(("staple", path))

        self._stub_notarize_calls(fake_run, fake_capture, fake_staple)

        # Without a notary key, notarize is a no-op.
        self.mac.Signing("rcodesign").notarize("/tmp/Linger.app", delay_seconds=0)
        self.assertEqual(calls, [])

        # Happy path: submit (no --wait/--staple) -> wait(uuid) -> log(uuid) -> staple.
        signing = self.mac.Signing("rcodesign", "id.p12", "id.password", "notary.json")
        signing.notarize("/tmp/Linger.app", delay_seconds=0)
        self.assertEqual(len(calls), 4)
        submit_call, wait_call, log_call, staple_call = calls
        self.assertEqual(
            submit_call,
            (
                "capture",
                ("rcodesign", "notary-submit", "--api-key-file", "notary.json", "/tmp/Linger.app"),
                True,
                True,
            ),
        )
        self.assertNotIn("--wait", submit_call[1])
        self.assertNotIn("--staple", submit_call[1])
        self.assertEqual(wait_call[0], "run")
        self.assertEqual(
            wait_call[1][:5],
            ("rcodesign", "notary-wait", "--api-key-file", "notary.json", "--max-wait-seconds"),
        )
        self.assertTrue(1 <= int(wait_call[1][5]) <= 3600)
        self.assertEqual(wait_call[1][6], submission_id)
        self.assertEqual(
            log_call,
            (
                "capture",
                ("rcodesign", "notary-log", "--api-key-file", "notary.json", submission_id),
                False,
                False,
            ),
        )
        self.assertEqual(staple_call, ("staple", "/tmp/Linger.app"))

    def test_signing_notarize_retries_transient_submit_and_propagates_exhaustion(self):
        submission_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        calls = []
        submit_failures = 2

        def fake_run(*args, **kwargs):
            calls.append(args[1])

        def fake_capture(*args, merge_stderr=False, stream=False):
            nonlocal submit_failures
            calls.append(args[1])
            if args[1] == "notary-submit":
                if submit_failures > 0:
                    submit_failures -= 1
                    raise subprocess.CalledProcessError(1, args)
                return f"created submission ID: {submission_id}\n"
            return json.dumps({"status": "Accepted"})

        def fake_staple(signing_self, path):
            calls.append("staple")

        self._stub_notarize_calls(fake_run, fake_capture, fake_staple)
        signing = self.mac.Signing("rcodesign", "id.p12", "id.password", "notary.json")

        signing.notarize("/tmp/Linger.app", submit_attempts=3, delay_seconds=0)
        self.assertEqual(calls, ["notary-submit", "notary-submit", "notary-submit", "notary-wait", "notary-log", "staple"])

        calls.clear()
        submit_failures = 3
        with self.assertRaises(subprocess.CalledProcessError):
            signing.notarize("/tmp/Linger.app", submit_attempts=3, delay_seconds=0)
        self.assertEqual(calls, ["notary-submit", "notary-submit", "notary-submit"])

    def test_signing_notarize_retries_wait_with_same_submission_id(self):
        submission_id = "11111111-2222-3333-4444-555555555555"
        calls = []
        wait_failures = 2

        def fake_run(*args, **kwargs):
            nonlocal wait_failures
            calls.append((args[1], args[-1]))
            if args[1] == "notary-wait" and wait_failures > 0:
                wait_failures -= 1
                raise subprocess.CalledProcessError(1, args)

        def fake_capture(*args, merge_stderr=False, stream=False):
            calls.append((args[1], args[-1]))
            if args[1] == "notary-submit":
                return f"created submission ID: {submission_id}\n"
            return json.dumps({"status": "Accepted"})

        def fake_staple(signing_self, path):
            calls.append(("staple", path))

        self._stub_notarize_calls(fake_run, fake_capture, fake_staple)
        signing = self.mac.Signing("rcodesign", "id.p12", "id.password", "notary.json")

        signing.notarize("/tmp/Linger.dmg", wait_attempts=4, delay_seconds=0)
        self.assertEqual(calls, [
            ("notary-submit", "/tmp/Linger.dmg"),
            ("notary-wait", submission_id),
            ("notary-wait", submission_id),
            ("notary-wait", submission_id),
            ("notary-log", submission_id),
            ("staple", "/tmp/Linger.dmg"),
        ])

        # Exhausted wait retries propagate without calling notary-log or staple.
        calls.clear()
        wait_failures = 3
        with self.assertRaises(subprocess.CalledProcessError):
            signing.notarize("/tmp/Linger.dmg", wait_attempts=3, delay_seconds=0)
        self.assertEqual(calls, [
            ("notary-submit", "/tmp/Linger.dmg"),
            ("notary-wait", submission_id),
            ("notary-wait", submission_id),
            ("notary-wait", submission_id),
        ])

    def test_signing_notarize_stops_retrying_wait_when_budget_cannot_cover_delay(self):
        submission_id = "22222222-3333-4444-5555-666666666666"
        signing = self.mac.Signing("rcodesign", "id.p12", "id.password", "notary.json")

        for label, delay_seconds, ticks in (
            ("remaining_lte_delay", 5, [100.0, 100.0, 106.0]),
            ("already_exhausted", 0, [100.0, 100.0, 110.0]),
        ):
            with self.subTest(case=label):
                calls = []
                sleeps = []

                def fake_run(*args, **kwargs):
                    calls.append(args[1])
                    raise subprocess.CalledProcessError(1, args)

                def fake_capture(*args, merge_stderr=False, stream=False):
                    calls.append(args[1])
                    return f"created submission ID: {submission_id}\n"

                def fake_staple(signing_self, path):
                    calls.append("staple")

                self._stub_notarize_calls(fake_run, fake_capture, fake_staple)
                with mock.patch.object(self.mac.time, "monotonic", side_effect=ticks), \
                        mock.patch.object(self.mac.time, "sleep", side_effect=sleeps.append):
                    with self.assertRaises(subprocess.CalledProcessError):
                        signing.notarize(
                            "/tmp/Linger.dmg",
                            wait_attempts=4,
                            delay_seconds=delay_seconds,
                            max_wait_seconds=10,
                        )
                self.assertEqual(calls, ["notary-submit", "notary-wait"])
                self.assertEqual(sleeps, [])

    def test_signing_notarize_fails_closed_without_submission_id(self):
        calls = []

        def fake_run(*args, **kwargs):
            calls.append(args[1])

        def fake_capture(*args, merge_stderr=False, stream=False):
            calls.append(args[1])
            return "upload finished with no submission identifier\n"

        def fake_staple(signing_self, path):
            calls.append("staple")

        self._stub_notarize_calls(fake_run, fake_capture, fake_staple)
        signing = self.mac.Signing("rcodesign", "id.p12", "id.password", "notary.json")

        with self.assertRaisesRegex(RuntimeError, "submission ID"):
            signing.notarize("/tmp/Linger.app", submit_attempts=3, delay_seconds=0)
        self.assertEqual(calls, ["notary-submit"])

    def test_signing_notarize_fails_closed_on_apple_rejection_and_retries_transient_log_errors(self):
        submission_id = "99999999-8888-7777-6666-555555555555"
        calls = []
        log_responses = []

        def fake_run(*args, **kwargs):
            calls.append(args[1])

        def fake_capture(*args, merge_stderr=False, stream=False):
            calls.append(args[1])
            if args[1] == "notary-submit":
                return f"created submission ID: {submission_id}\n"
            response = log_responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return response

        def fake_staple(signing_self, path):
            calls.append("staple")

        self._stub_notarize_calls(fake_run, fake_capture, fake_staple)
        signing = self.mac.Signing("rcodesign", "id.p12", "id.password", "notary.json")

        # Apple Invalid verdict fails immediately without retrying notary-log or stapling.
        log_responses[:] = [json.dumps({"status": "Invalid", "issues": [{"message": "unsigned"}]})]
        with self.assertRaisesRegex(RuntimeError, "did not accept.*Invalid"):
            signing.notarize("/tmp/Linger.app", log_attempts=3, delay_seconds=0)
        self.assertEqual(calls, ["notary-submit", "notary-wait", "notary-log"])

        # Transient notary-log errors retry and succeed when Accepted.
        calls.clear()
        log_responses[:] = [
            subprocess.CalledProcessError(1, ("rcodesign", "notary-log")),
            json.dumps({"status": "Accepted"}),
        ]
        signing.notarize("/tmp/Linger.app", log_attempts=3, delay_seconds=0)
        self.assertEqual(calls, ["notary-submit", "notary-wait", "notary-log", "notary-log", "staple"])

        # Invalid JSON fails closed immediately without retrying or stapling.
        calls.clear()
        log_responses[:] = ["not-json"]
        with self.assertRaisesRegex(RuntimeError, "not valid JSON"):
            signing.notarize("/tmp/Linger.app", log_attempts=3, delay_seconds=0)
        self.assertEqual(calls, ["notary-submit", "notary-wait", "notary-log"])

        # Non-object JSON fails closed without retrying or stapling.
        calls.clear()
        log_responses[:] = ["[]"]
        with self.assertRaisesRegex(RuntimeError, "did not accept"):
            signing.notarize("/tmp/Linger.app", log_attempts=3, delay_seconds=0)
        self.assertEqual(calls, ["notary-submit", "notary-wait", "notary-log"])

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

    def test_native_bundle_check_and_refresh_shared_node_macos(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        resources = os.path.join(root, "Linger.app", "Contents", "Resources")
        native_dir = os.path.join(resources, "app", "dist", "installer", "native")
        runtime_dir = os.path.join(native_dir, "runtime-darwin-arm64")
        runtime_files_dir = os.path.join(runtime_dir, "runtime")
        shared_node = os.path.join(resources, "runtime", "bin", "node")
        os.makedirs(runtime_files_dir)
        os.makedirs(os.path.dirname(shared_node))

        addon = os.path.join(runtime_files_dir, "addon.node")
        with open(addon, "wb") as out:
            out.write(MACHO)
        with open(shared_node, "wb") as out:
            out.write(MACHO)

        files_json = os.path.join(runtime_files_dir, "files.json")
        with open(files_json, "w") as out:
            json.dump({
                "schema": 1,
                "target": "darwin-arm64",
                "files": {
                    "addon.node": {"bytes": os.path.getsize(addon), "sha256": sha256(addon)},
                },
            }, out)
        manifest_path = os.path.join(runtime_dir, "manifest.json")
        with open(manifest_path, "w") as out:
            json.dump({
                "schema": 1,
                "target": "darwin-arm64",
                "layout": "directory",
                "directory": {"file": "runtime/files.json", "bytes": os.path.getsize(files_json), "sha256": sha256(files_json)},
                "node": {
                    "version": "26.5.0",
                    "shared": True,
                    "binary": "runtime/bin/node",
                    "bytes": os.path.getsize(shared_node),
                    "sha256": sha256(shared_node),
                },
            }, out)

        native_bundle.check_runtime("darwin-arm64", native=native_dir, computer_tools_dir=resources)

        # Signing rewrites both addon.node and the shared Contents/Resources/runtime/bin/node.
        signed_addon = self.signed_macho(0x10000, b"cms-addon")
        signed_node = self.signed_macho(0x10000, b"cms-node-signed")
        with open(addon, "wb") as out:
            out.write(signed_addon)
        with open(shared_node, "wb") as out:
            out.write(signed_node)

        # Before refresh, check_runtime rejects the modified shared node.
        with self.assertRaises(SystemExit):
            native_bundle.check_runtime("darwin-arm64", native=native_dir, computer_tools_dir=resources)

        native_bundle.refresh(native_dir, "darwin-arm64", shared_node=shared_node)
        native_bundle.check_runtime("darwin-arm64", native=native_dir, computer_tools_dir=resources)
        with open(manifest_path) as source:
            refreshed = json.load(source)
        self.assertTrue(refreshed["node"]["shared"])
        self.assertEqual(refreshed["node"]["sha256"], sha256(shared_node))
        self.assertEqual(refreshed["node"]["bytes"], os.path.getsize(shared_node))

        # Two-argument refresh resolves the shared node relative to Contents/Resources/app/dist/installer/native.
        resigned_node = self.signed_macho(0x10000, b"cms-node-resigned-v2")
        with open(shared_node, "wb") as out:
            out.write(resigned_node)
        native_bundle.refresh(native_dir, "darwin-arm64")
        native_bundle.check_runtime("darwin-arm64", native=native_dir, computer_tools_dir=resources)
        with open(manifest_path) as source:
            refreshed_again = json.load(source)
        self.assertEqual(refreshed_again["node"]["sha256"], sha256(shared_node))
        self.assertEqual(refreshed_again["node"]["bytes"], os.path.getsize(shared_node))

    def test_native_bundle_check_shared_node_archive_layout(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        native_dir = os.path.join(root, "native")
        runtime_dir = os.path.join(native_dir, "runtime-win32-x64")
        tools_dir = os.path.join(root, "computer-tools", "win32-x64")
        shared_node = os.path.join(tools_dir, "runtime", "bin", "node.exe")
        os.makedirs(runtime_dir)
        os.makedirs(os.path.dirname(shared_node))

        archive_path = os.path.join(runtime_dir, "runtime.tar.zst")
        with open(archive_path, "wb") as out:
            out.write(b"zstd-payload")
        with open(shared_node, "wb") as out:
            out.write(b"MZ-node-binary")

        with open(os.path.join(runtime_dir, "manifest.json"), "w") as out:
            json.dump({
                "schema": 1,
                "target": "win32-x64",
                "layout": "archive",
                "archive": {
                    "file": "runtime.tar.zst",
                    "bytes": os.path.getsize(archive_path),
                    "sha256": sha256(archive_path),
                },
                "node": {
                    "version": "26.5.0",
                    "shared": True,
                    "binary": "runtime/bin/node.exe",
                    "bytes": os.path.getsize(shared_node),
                    "sha256": sha256(shared_node),
                },
            }, out)

        native_bundle.check_runtime("win32-x64", native=native_dir, computer_tools_dir=tools_dir)
        with open(shared_node, "wb") as out:
            out.write(b"tampered")
        with self.assertRaises(SystemExit):
            native_bundle.check_runtime("win32-x64", native=native_dir, computer_tools_dir=tools_dir)


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
        try:
            os.symlink("hello.txt", os.path.join(bundle, "link.txt"))
        except OSError as error:
            # Windows lets a standard user create links only in Developer Mode.
            self.skipTest(f"cannot create a symlink here: {error}")

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
