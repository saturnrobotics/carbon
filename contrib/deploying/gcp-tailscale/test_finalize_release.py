"""Exercise final receipt publication against synthetic daemon observations."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class FinalizeReleaseTests(unittest.TestCase):
    def invoke(
        self,
        *,
        generation=4,
        image=None,
        health="healthy",
        containers="synthetic-container",
        compose_image=None,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            compose_path = root / "compose.json"
            manifest_path = root / "release-manifest.json"
            identity = "sha256:" + "a" * 64
            config_digest = "sha256:" + "b" * 64
            previous = {
                "generation": generation,
                "services": {"erp": {"source_commit": "c" * 40}},
            }
            manifest_path.write_text(json.dumps(previous))
            before = manifest_path.read_bytes()
            services = {
                name: {
                    "image_digest": identity,
                    "config_digest": config_digest,
                    "source_commit": "d" * 40,
                }
                for name in ("erp", "mes")
            }
            planned = {
                "expected_generation": 4,
                "generation": 5,
                "services": services,
                "prepared_source_commit": "d" * 40,
                "input_owners": {"apps/erp": ["erp"]},
                "maintenance_inputs": {"source/synthetic": "sha256:" + "e" * 64},
                "maintenance_fingerprint": "sha256:" + "f" * 64,
            }
            config_path.write_text(
                json.dumps({"RELEASE_PLAN": planned, "DEPLOY_REVISION": "d" * 40})
            )
            compose_path.write_text(
                json.dumps(
                    {
                        "services": {
                            name: {
                                "image": compose_image or identity,
                                "labels": {
                                    "com.carbon.release.config-digest": config_digest
                                },
                            }
                            for name in services
                        }
                    }
                )
            )
            docker = root / "docker"
            docker.write_text("""#!/usr/bin/env python3
import json, os, sys
if sys.argv[1] == "ps":
    print(os.environ["SYNTHETIC_CONTAINERS"])
elif sys.argv[1] == "inspect":
    print(json.dumps({"image": os.environ["SYNTHETIC_IMAGE"], "config": os.environ["SYNTHETIC_CONFIG"],
                      "status": "running", "health": os.environ["SYNTHETIC_HEALTH"]}))
else:
    sys.exit(99)
""")
            docker.chmod(0o755)
            env = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "SYNTHETIC_CONTAINERS": containers,
                "SYNTHETIC_IMAGE": image or identity,
                "SYNTHETIC_CONFIG": config_digest,
                "SYNTHETIC_HEALTH": health,
            }
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "host_release.py"),
                    "finalize",
                    str(config_path),
                    str(compose_path),
                    str(manifest_path),
                ],
                capture_output=True,
                text=True,
                env=env,
            )
            after = manifest_path.read_bytes()
            return result, before, after, planned

    def test_verified_live_images_publish_the_final_receipt_and_ownership(self):
        result, before, after, plan = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(before, after)
        saved = json.loads(after)
        self.assertEqual(saved["generation"], 5)
        for key in (
            "services",
            "prepared_source_commit",
            "input_owners",
            "maintenance_inputs",
            "maintenance_fingerprint",
        ):
            self.assertEqual(saved[key], plan[key])

    def test_stale_generation_keeps_last_successful_manifest_byte_identical(self):
        result, before, after, plan = self.invoke(generation=6)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("generation", result.stderr)
        self.assertEqual(before, after)

    def test_image_or_health_drift_cannot_publish_a_successful_receipt(self):
        for condition in (
            {"image": "sha256:" + "9" * 64},
            {"compose_image": "synthetic/mutable:latest"},
            {"health": "unhealthy"},
            {"containers": ""},
            {"containers": "one\ntwo"},
        ):
            with self.subTest(condition=condition):
                result, before, after, plan = self.invoke(**condition)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(before, after)
                self.assertIn("erp", result.stderr)


if __name__ == "__main__":
    unittest.main()
