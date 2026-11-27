import hashlib
import json
import os
import tempfile
import unittest

import native_bundle


class NativeBundleV2SeedTest(unittest.TestCase):
    def _write_seed(self, seed_dir, target="darwin-arm64", tamper=False, bad_path=False):
        bundles = {}
        for mod in native_bundle.V2_SEED_MODULES:
            filename = f"{mod}-111111111111.tar.zst"
            full = os.path.join(seed_dir, filename)
            data = f"payload-{mod}".encode("utf-8")
            with open(full, "wb") as f:
                f.write(data)
            digest = hashlib.sha256(data).hexdigest()
            if tamper and mod == "web":
                digest = "0" * 64
            bundles[mod] = {
                "artifactId": f"{mod}-111111111111",
                "file": "../escape.tar.zst" if (bad_path and mod == "web") else filename,
                "sha256": digest,
                "bytes": len(data),
            }
        manifest = {
            "schema": 1,
            "appVersion": "0.2.0",
            "target": target,
            "bundles": bundles,
        }
        with open(os.path.join(seed_dir, "seed-manifest.json"), "w") as f:
            json.dump(manifest, f)

    def test_valid_seed_manifest_passes_without_source_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_seed(tmp)
            result = native_bundle.check_seed_manifest("darwin-arm64", seed_dir=tmp)
            self.assertEqual(result["appVersion"], "0.2.0")

    def test_tampered_bundle_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_seed(tmp, tamper=True)
            with self.assertRaises(SystemExit):
                native_bundle.check_seed_manifest("darwin-arm64", seed_dir=tmp)

    def test_path_escape_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_seed(tmp, bad_path=True)
            with self.assertRaises(SystemExit):
                native_bundle.check_seed_manifest("darwin-arm64", seed_dir=tmp)

    def test_wrong_target_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write_seed(tmp, target="win32-x64")
            with self.assertRaises(SystemExit):
                native_bundle.check_seed_manifest("darwin-arm64", seed_dir=tmp)

    def test_shell_baseline_seed_manifest_passes_without_archives(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = {
                "schema": 1,
                "mode": "shell-baseline",
                "appVersion": "0.1.11-v2test.0",
                "channel": "stable",
                "compat": {
                    "minShellVersion": "0.1.11-v2test.0",
                    "minNativeDepsHash": "sha256:" + "a" * 64,
                    "runnerGatewayProtocol": 1,
                    "dbSchemaEpoch": 1,
                    "rollbackSafe": True,
                },
                "infra": {
                    "node": "bundled",
                    "postgres": "bundled",
                    "voiceTools": "bundled",
                    "nodeDeps": "infra/node-deps/nd-" + "a" * 16,
                },
                "bundles": {
                    mod: {"artifactId": "shell-baseline", "inputHash": "b" * 64}
                    for mod in native_bundle.V2_SEED_MODULES
                },
            }
            with open(os.path.join(tmp, "seed-manifest.json"), "w") as f:
                json.dump(manifest, f)
            result = native_bundle.check_seed_manifest("linux-x64", seed_dir=tmp)
            self.assertEqual(result["mode"], "shell-baseline")
            self.assertEqual(result["appVersion"], "0.1.11-v2test.0")


if __name__ == "__main__":
    unittest.main()
