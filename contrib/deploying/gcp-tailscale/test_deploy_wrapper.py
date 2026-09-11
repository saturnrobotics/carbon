"""Run the deployment wrapper with real isolated Python and offline package inputs."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent


class DeployWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="carbon deploy wrapper ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.wrapper = self.root / "checkout with spaces/deploy.sh"
        self.wrapper.parent.mkdir()
        shutil.copyfile(HERE / "deploy.sh", self.wrapper)
        (self.wrapper.parent / "deploy.py").write_text(
            "import json, os, pathlib, sys, yaml\n"
            "assert yaml.__version__ == '6.0.2'\n"
            "pathlib.Path(os.environ['DEPLOY_FIXTURE_RESULT']).write_text(json.dumps(sys.argv[1:]))\n"
            "print('deployment entrypoint reached')\n"
        )
        binaries = self.root / "bin"
        binaries.mkdir()
        shim = binaries / "python3"
        shim.write_text(
            f"#!{sys.executable}\nimport os, sys\n"
            "if len(sys.argv) > 1 and sys.argv[1] == '-c':\n    sys.exit(1)\n"
            f"os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])\n"
        )
        shim.chmod(0o755)
        self.wheels = self.root / "synthetic-private-index"
        self.wheels.mkdir()
        self.wheel = self.wheels / "pyyaml-6.0.2-py3-none-any.whl"
        with zipfile.ZipFile(self.wheel, "w") as archive:
            archive.writestr("yaml/__init__.py", "__version__ = '6.0.2'\n")
            archive.writestr(
                "pyyaml-6.0.2.dist-info/METADATA",
                "Metadata-Version: 2.1\nName: PyYAML\nVersion: 6.0.2\n",
            )
            archive.writestr(
                "pyyaml-6.0.2.dist-info/WHEEL",
                "Wheel-Version: 1.0\nGenerator: synthetic-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            )
            archive.writestr("pyyaml-6.0.2.dist-info/RECORD", "")
        self.result = self.root / "invocation.json"
        self.env = {
            **os.environ,
            "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
            "PIP_NO_INDEX": "1",
            "PIP_FIND_LINKS": self.wheels.as_uri(),
            "PIP_CONFIG_FILE": os.devnull,
            "PYTHONPATH": "",
            "DEPLOY_FIXTURE_RESULT": str(self.result),
        }

    def run_wrapper(self, *args):
        return subprocess.run(
            ["bash", str(self.wrapper), *args],
            env=self.env,
            cwd=self.root,
            text=True,
            capture_output=True,
            timeout=60,
        )

    def test_missing_yaml_bootstraps_pinned_local_tools_and_preserves_arguments(self):
        args = ["--check", "--config", "private config with spaces.env"]
        result = self.run_wrapper(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.result.read_text()), args)
        self.assertTrue(
            (self.wrapper.parent / ".local/deploy-python/venv/bin/python").exists()
        )
        self.assertNotIn("synthetic-private-index", result.stdout + result.stderr)
        self.wheel.unlink()
        repeated = self.run_wrapper("--help")
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(self.result.read_text()), ["--help"])

    def test_usable_interpreter_requires_no_install_or_local_cache(self):
        prepared = self.run_wrapper("--help")
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        self.env["PATH"] = (
            str(self.wrapper.parent / ".local/deploy-python/venv/bin")
            + os.pathsep
            + os.environ["PATH"]
        )
        next_directory = self.root / "second checkout with spaces"
        next_directory.mkdir()
        for name in ("deploy.sh", "deploy.py"):
            shutil.copyfile(self.wrapper.parent / name, next_directory / name)
        self.wrapper = next_directory / "deploy.sh"
        self.wheel.unlink()
        result = self.run_wrapper("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((next_directory / ".local").exists())
        self.assertEqual(json.loads(self.result.read_text()), ["--check"])

    def test_install_failure_stops_before_deployment_and_keeps_details_private(self):
        self.wheel.unlink()
        result = self.run_wrapper("--apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.result.exists())
        self.assertIn("Unable to prepare deployment Python tools", result.stderr)
        self.assertNotIn("synthetic-private-index", result.stdout + result.stderr)
        log = self.wrapper.parent / ".local/deploy-python/bootstrap.log"
        self.assertTrue(log.is_file())
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_symlinked_local_tool_directory_is_rejected_without_writing_outside(self):
        external = self.root / "external"
        external.mkdir()
        (self.wrapper.parent / ".local").symlink_to(external, target_is_directory=True)
        result = self.run_wrapper("--help")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(external.iterdir()), [])
        self.assertFalse(self.result.exists())


if __name__ == "__main__":
    unittest.main()
