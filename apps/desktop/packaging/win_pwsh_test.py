"""Checks for Windows Desktop PowerShell 7 archive caching, extraction, and zip verification.

    python3 -m unittest discover -s apps/desktop/packaging -p '*_test.py'
"""
import hashlib
import importlib.util
import io
import os
import shutil
import tempfile
import unittest
from unittest import mock
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load_module(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, *relative_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WindowsPowerShellPackagingTest(unittest.TestCase):
    def setUp(self):
        self.win = load_module("win_package", ("win", "package.py"))
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)

    def test_pwsh_zip_reuses_verified_cache_and_rejects_mismatched_download(self):
        cache = os.path.join(self.root, "cache")
        os.makedirs(cache)
        cached = os.path.join(cache, self.win.PWSH_ARCHIVE)
        payload = b"valid-pwsh-archive"
        payload_sha = hashlib.sha256(payload).hexdigest()

        with mock.patch.object(self.win, "PWSH_SHA256", payload_sha):
            with open(cached, "wb") as out:
                out.write(payload)
            with mock.patch.object(self.win.urllib.request, "urlopen", side_effect=AssertionError("unexpected fetch")):
                self.assertEqual(self.win.pwsh_zip(cache), cached)

            with open(cached, "wb") as out:
                out.write(b"corrupt-cache")
            with mock.patch.object(self.win.urllib.request, "urlopen", return_value=io.BytesIO(payload)) as fetch:
                self.assertEqual(self.win.pwsh_zip(cache), cached)
            self.assertEqual(fetch.call_count, 1)
            with open(cached, "rb") as cached_file:
                self.assertEqual(hashlib.sha256(cached_file.read()).hexdigest(), payload_sha)

            os.remove(cached)
            with mock.patch.object(self.win.urllib.request, "urlopen", return_value=io.BytesIO(b"bad-download")):
                with self.assertRaises(SystemExit) as stopped:
                    self.win.pwsh_zip(cache)
            self.assertIn("sha256 mismatch", str(stopped.exception))
            self.assertFalse(os.path.exists(cached + ".part"))
            self.assertFalse(os.path.exists(cached))

    def test_extract_pwsh_unpacks_runtime_and_rejects_missing_executable(self):
        good_zip = os.path.join(self.root, "good-pwsh.zip")
        with zipfile.ZipFile(good_zip, "w") as archive:
            archive.writestr("pwsh.exe", b"MZ-pwsh7")
            archive.writestr("Modules/Microsoft.PowerShell.Utility/Utility.psd1", b"@{}\n")
        dest = os.path.join(self.root, "stage", "resources", "runtime", "pwsh")
        self.win.extract_pwsh(good_zip, dest)
        with open(os.path.join(dest, "pwsh.exe"), "rb") as extracted_pwsh:
            self.assertEqual(extracted_pwsh.read(), b"MZ-pwsh7")
        self.assertTrue(os.path.isfile(os.path.join(dest, "Modules", "Microsoft.PowerShell.Utility", "Utility.psd1")))

        missing_zip = os.path.join(self.root, "missing-pwsh.zip")
        with zipfile.ZipFile(missing_zip, "w") as archive:
            archive.writestr("System.Management.Automation.dll", b"dll")
        with self.assertRaises(SystemExit) as stopped:
            self.win.extract_pwsh(missing_zip, os.path.join(self.root, "missing-dest"))
        self.assertIn("pwsh.exe", str(stopped.exception))

    def test_verify_pwsh_archive_requires_non_empty_bundled_executable(self):
        good_zip = os.path.join(self.root, "good.zip")
        with zipfile.ZipFile(good_zip, "w") as archive:
            archive.writestr(self.win.PWSH_ARCHIVE_ENTRY, b"MZ-pwsh7")
        self.win.verify_pwsh_archive(good_zip)

        missing_zip = os.path.join(self.root, "missing.zip")
        with zipfile.ZipFile(missing_zip, "w") as archive:
            archive.writestr("Linger/resources/runtime/bin/node.exe", b"MZ-node")
        with self.assertRaises(SystemExit) as stopped:
            self.win.verify_pwsh_archive(missing_zip)
        self.assertIn("pwsh.exe", str(stopped.exception))

        empty_zip = os.path.join(self.root, "empty.zip")
        with zipfile.ZipFile(empty_zip, "w") as archive:
            archive.writestr(self.win.PWSH_ARCHIVE_ENTRY, b"")
        with self.assertRaises(SystemExit) as stopped:
            self.win.verify_pwsh_archive(empty_zip)
        self.assertIn("pwsh.exe", str(stopped.exception))


if __name__ == "__main__":
    unittest.main()
