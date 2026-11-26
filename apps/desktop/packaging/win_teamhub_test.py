"""Checks for Windows Desktop TeamHub CLI archive verification.

    python3 -m unittest discover -s apps/desktop/packaging -p '*_test.py'
"""
import importlib.util
import os
import shutil
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load_module(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, *relative_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WindowsTeamHubPackagingTest(unittest.TestCase):
    def setUp(self):
        self.win = load_module("win_package", ("win", "package.py"))
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)

    def test_verify_teamhub_cli_archive_requires_non_empty_exe_and_rejects_cmd(self):
        good_zip = os.path.join(self.root, "good.zip")
        with zipfile.ZipFile(good_zip, "w") as archive:
            archive.writestr("Linger/resources/app/dist/teamhub-cli/teamhub.exe", b"MZ-native")
            archive.writestr("Linger/resources/app/dist/teamhub-cli/teamhub.js", b"console.log(1)\n")
            archive.writestr("Linger/resources/app/dist/teamhub-cli/teamhub", b"#!/bin/sh\n")
        self.win.verify_teamhub_cli_archive(good_zip)

        missing_zip = os.path.join(self.root, "missing.zip")
        with zipfile.ZipFile(missing_zip, "w") as archive:
            archive.writestr("Linger/resources/app/dist/teamhub-cli/teamhub.js", b"console.log(1)\n")
        with self.assertRaises(SystemExit) as stopped:
            self.win.verify_teamhub_cli_archive(missing_zip)
        self.assertIn("teamhub.exe", str(stopped.exception))

        empty_zip = os.path.join(self.root, "empty.zip")
        with zipfile.ZipFile(empty_zip, "w") as archive:
            archive.writestr("Linger/resources/app/dist/teamhub-cli/teamhub.exe", b"")
        with self.assertRaises(SystemExit) as stopped:
            self.win.verify_teamhub_cli_archive(empty_zip)
        self.assertIn("teamhub.exe", str(stopped.exception))

        legacy_zip = os.path.join(self.root, "legacy.zip")
        with zipfile.ZipFile(legacy_zip, "w") as archive:
            archive.writestr("Linger/resources/app/dist/teamhub-cli/teamhub.exe", b"MZ-native")
            archive.writestr("Linger/resources/app/dist/teamhub-cli/teamhub.cmd", b"@echo off\r\n")
        with self.assertRaises(SystemExit) as stopped:
            self.win.verify_teamhub_cli_archive(legacy_zip)
        self.assertIn("teamhub.cmd", str(stopped.exception))


if __name__ == "__main__":
    unittest.main()
