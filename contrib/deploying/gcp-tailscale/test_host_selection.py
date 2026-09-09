"""Execute the real host prepare branch with a synthetic Docker command boundary."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class HostSelectionTests(unittest.TestCase):
    def run_prepare(self, *, maintenance, build, missing=None, mismatched=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "config.json"
            prepared = root / "prepared" / ("a" * 40)
            prepared.mkdir(parents=True)
            revision = "a" * 40
            old = "b" * 40
            services = {
                name: {
                    "source_commit": revision if name in build else old,
                    "image_digest": None if name in build else "sha256:" + "1" * 64,
                    "fingerprints": {"build": "sha256:" + "2" * 64},
                }
                for name in ("erp", "mes")
            }
            config.write_text(
                json.dumps(
                    {
                        "DEPLOY_REVISION": revision,
                        "RELEASE_MAINTENANCE": maintenance,
                        "RELEASE_PLAN": {
                            "build": {name: ["changed"] for name in build},
                            "migrate": {},
                            "services": services,
                        },
                    }
                )
            )
            stack = {
                "services": {
                    name: {
                        "image": "carbon/" + name + ":" + service["source_commit"],
                        "labels": {},
                    }
                    for name, service in services.items()
                }
            }
            (prepared / "compose.json").write_text(json.dumps(stack))
            tls = root / "tls/live/carbon"
            tls.mkdir(parents=True)
            (tls / "fullchain.pem").touch()
            (tls / "privkey.pem").touch()
            commands = root / "commands.jsonl"
            docker = root / "docker"
            docker.write_text("""#!/usr/bin/env python3
import json, os, sys
with open(os.environ["COMMAND_LOG"], "a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["image", "inspect"]:
    target = sys.argv[-1]
    if os.environ.get("MISSING_IMAGE") and os.environ["MISSING_IMAGE"] in target:
        sys.exit(1)
    digit = "9" if os.environ.get("MISMATCHED_IMAGE") and os.environ["MISMATCHED_IMAGE"] in target else "1"
    print("sha256:" + digit * 64)
""")
            docker.chmod(0o755)
            source = (HERE / "host-deploy.sh").read_text()
            functions = source[
                source.index("config_value() {") : source.index('case "$ACTION" in')
            ]
            prepare = source.split("  prepare)\n", 1)[1].split("    ;;", 1)[0]
            # Rendering is covered by real preview/materialization equivalence tests.
            # Isolate only privileged path and readiness boundaries here.
            prepare = prepare.replace(
                'python3 "$HERE/render.py" "$CONFIG" "$REPO" "$PREPARED"', ":"
            )
            script = (
                """set -euo pipefail
CONFIG=$1
STATE=$2
PREPARED=$2/prepared
HERE=$3
REPO=$4
REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
fail() { echo "$*" >&2; exit 1; }
"""
                + functions
                + "\nverify_tailnet() { :; }\n"
                + prepare
            )
            env = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "COMMAND_LOG": str(commands),
                "MISSING_IMAGE": missing or "",
                "MISMATCHED_IMAGE": mismatched or "",
            }
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    script,
                    "fixture",
                    str(config),
                    str(root),
                    str(HERE),
                    str(HERE.parents[2]),
                ],
                text=True,
                capture_output=True,
                env=env,
            )
            calls = (
                [json.loads(line) for line in commands.read_text().splitlines()]
                if commands.exists()
                else []
            )
            return (
                result,
                calls,
                json.loads(config.read_text()),
                json.loads((prepared / "compose.json").read_text()),
            )

    def run_routine(self, failure=""):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            runtime.mkdir()
            prepared = root / "prepared" / ("a" * 40)
            prepared.mkdir(parents=True)
            config = root / "config.json"
            old_mes = {
                "image": "carbon/mes:" + "b" * 40,
                "environment": {"UNCHANGED": "yes"},
            }
            current = {
                "services": {
                    "erp": {"image": "old"},
                    "mes": old_mes,
                    "postgres": {"image": "synthetic/postgres:1"},
                },
                "secrets": {"shared": {"file": "/synthetic/shared"}},
            }
            (runtime / "compose.json").write_text(json.dumps(current))
            desired = {
                "services": {
                    "erp": {"image": "sha256:" + "1" * 64, "secrets": ["erp_setting"]},
                    "mes": {"image": "unselected"},
                },
                "secrets": {"erp_setting": {"file": "/synthetic/erp-setting"}},
            }
            (prepared / "compose.json").write_text(json.dumps(desired))
            plan = {
                "generation": 1,
                "expected_generation": 0,
                "prepared_source_commit": "a" * 40,
                "input_owners": {"apps/erp": ["erp"]},
                "deploy": {"erp": ["config changed"]},
                "services": {"erp": {}, "mes": {}},
            }
            config.write_text(
                json.dumps({"DEPLOY_REVISION": "a" * 40, "RELEASE_PLAN": plan})
            )
            source = (HERE / "host-deploy.sh").read_text()
            functions = source[
                source.index("config_value() {") : source.index('case "$ACTION" in')
            ]
            functions = functions.replace("timeout=${2:-240}", "timeout=${2:-1}")
            apply = source.split("  routine-apply)\n", 1)[1].split("    ;;", 1)[0]
            script = (
                """set -euo pipefail
CONFIG=$1
STATE=$2
FAILURE=$3
CURRENT=$2/runtime/compose.json
COMMAND_LOG=$2/commands.jsonl
fail() { echo "$*" >&2; exit 1; }
"""
                + functions
                + """
verify_tailnet() { :; }
sleep() { :; }
docker() {
  python3 -c 'import json,sys; open(sys.argv[1],"a").write(json.dumps(sys.argv[2:])+"\\n")' "$COMMAND_LOG" "$@"
  candidate=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["services"]["erp"]["image"].startswith("sha256:"))' "$CURRENT")
  if [ "$FAILURE" = startup ] && [ "$candidate" = True ] && [[ " $* " = *" up "* ]]; then return 1; fi
  if [ "$1" = inspect ]; then
    if [ "$FAILURE" = health ] && [ "$candidate" = True ]; then echo unhealthy; else echo healthy; fi
  fi
  if [ "$1" = compose ] && [[ " $* " = *" ps "* ]]; then echo synthetic-erp; fi
}
"""
                + apply
            )
            result = subprocess.run(
                ["bash", "-c", script, "fixture", str(config), str(root), failure],
                capture_output=True,
                text=True,
            )
            if failure:
                self.assertNotEqual(result.returncode, 0, result.stdout)
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
            calls = [
                json.loads(line)
                for line in (root / "commands.jsonl").read_text().splitlines()
            ]
            mutations = [call for call in calls if "up" in call or "stop" in call]
            self.assertEqual(len(mutations), 2 if failure else 1)
            self.assertEqual(mutations[0][-4:], ["up", "-d", "--no-deps", "erp"])
            active = json.loads((runtime / "compose.json").read_text())
            self.assertEqual(active["services"]["mes"], old_mes)
            self.assertEqual(
                active["services"]["postgres"], current["services"]["postgres"]
            )
            if failure:
                self.assertEqual(active["services"]["erp"], current["services"]["erp"])
                self.assertFalse((runtime / "release-manifest.json").exists())
                self.assertIn("restored", result.stderr)
                return
            self.assertEqual(active["services"]["erp"], desired["services"]["erp"])
            self.assertIn("erp_setting", active["secrets"])
            self.assertEqual(
                active["secrets"]["erp_setting"], desired["secrets"]["erp_setting"]
            )
            self.assertEqual(active["secrets"]["shared"], current["secrets"]["shared"])
            self.assertFalse(
                (runtime / "release-manifest.json").exists(),
                "Applying services must not advance the baseline before final verification",
            )

    def test_routine_executes_only_selected_app_and_preserves_other_definitions(self):
        self.run_routine()

    def test_routine_startup_failure_restores_selected_app_without_advancing_baseline(
        self,
    ):
        self.run_routine("startup")

    def test_routine_health_failure_restores_selected_app_without_advancing_baseline(
        self,
    ):
        self.run_routine("health")

    def test_maintenance_builds_only_changed_app_and_ops(self):
        result, calls, config, stack = self.run_prepare(maintenance=True, build=["erp"])
        self.assertEqual(result.returncode, 0, result.stderr)
        builds = [call for call in calls if call[0] == "build"]
        self.assertEqual(len(builds), 2)
        self.assertTrue(any("APP=erp" in call for call in builds))
        self.assertFalse(any("APP=mes" in call for call in builds))
        self.assertTrue(any("ops" in call for call in builds))
        self.assertEqual(
            config["RELEASE_PLAN"]["services"]["erp"]["image_digest"],
            "sha256:" + "1" * 64,
        )
        self.assertEqual(
            config["RELEASE_PLAN"]["services"]["mes"]["source_commit"], "b" * 40
        )
        self.assertEqual(stack["services"]["mes"]["image"], "sha256:" + "1" * 64)

    def test_maintenance_without_app_changes_builds_only_ops(self):
        result, calls, config, stack = self.run_prepare(maintenance=True, build=[])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len([call for call in calls if call[0] == "build"]), 1)
        self.assertFalse(
            any(any(arg.startswith("APP=") for arg in call) for call in calls)
        )

    def test_config_only_rollout_builds_no_images(self):
        result, calls, config, stack = self.run_prepare(maintenance=False, build=[])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] == "build" for call in calls))

    def test_absent_or_retagged_reused_image_fails_before_promotion(self):
        for key in ("missing", "mismatched"):
            with self.subTest(key=key):
                result, calls, config, stack = self.run_prepare(
                    maintenance=True, build=[], **{key: "mes"}
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("mes", result.stderr)
                self.assertFalse(any("up" in call or "stop" in call for call in calls))


if __name__ == "__main__":
    unittest.main()
