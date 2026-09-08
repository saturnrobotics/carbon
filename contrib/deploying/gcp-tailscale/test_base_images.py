"""Exercise host build argument forwarding without Docker or cloud access."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class BaseImageTests(unittest.TestCase):
    def invoke_build(self, config):
        source = (HERE / "host-deploy.sh").read_text()
        self.assertIn("build_image() {", source)
        helper = source.split("build_image() {", 1)[1].split("\n}\n", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            config_path.write_text(json.dumps(config))
            script = '''set -euo pipefail
CONFIG=$1
REPO=/synthetic/repo
docker() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }
build_image() {''' + helper + '\n}\nbuild_image --target ops --tag carbon/ops:test\n'
            return subprocess.run(["bash", "-c", script, "test", str(config_path)], capture_output=True, text=True)

    def test_pinned_images_are_forwarded_as_literal_build_arguments(self):
        pins = {"NODE_IMAGE": "node:22@sha256:" + "a" * 64, "NODE_SLIM_IMAGE": "node:22-slim@sha256:" + "b" * 64}
        result = self.invoke_build({"RELEASE_BASE_IMAGES": pins})
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(result.stdout)
        for key, value in pins.items():
            self.assertIn(key + "=" + value, args)
        self.assertEqual(args[-5:], ["--target", "ops", "--tag", "carbon/ops:test", "/synthetic/repo"])

    def test_absent_mapping_preserves_legacy_defaults(self):
        result = self.invoke_build({})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ["build", "--target", "ops", "--tag", "carbon/ops:test", "/synthetic/repo"])

    def test_invalid_or_partial_pins_fail_before_docker(self):
        for pins in ({}, {"NODE_IMAGE": "node:22"}, {"NODE_IMAGE": "$(touch /tmp/never)", "NODE_SLIM_IMAGE": "node:22-slim@sha256:" + "b" * 64}, []):
            with self.subTest(pins=pins):
                result = self.invoke_build({"RELEASE_BASE_IMAGES": pins})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")

    def test_every_build_routes_through_pinning_helper(self):
        source = (HERE / "host-deploy.sh").read_text()
        self.assertEqual(source.count("docker build"), 1)
        self.assertIn('build_image --target ops', source)
        self.assertIn('build_image --build-arg "APP=$target"', source)
        dockerfile = (HERE.parents[2] / "Dockerfile").read_text()
        self.assertIn("ARG NODE_IMAGE=node:22", dockerfile)
        self.assertIn("ARG NODE_SLIM_IMAGE=node:22-slim", dockerfile)
        self.assertNotIn("FROM node:", dockerfile)


if __name__ == "__main__":
    unittest.main()
