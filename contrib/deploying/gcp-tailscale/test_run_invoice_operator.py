import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from run_invoice_operator import LOADER, pin_images, prepare, private_write, run


class InvoiceOperatorTest(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.directory = self.root / "operation"
        self.directory.mkdir(mode=0o700)
        self.revision = "a" * 40
        (self.runtime / "revision").write_text(self.revision)
        private_write(self.directory / "operator.json", {"requiredRevision": self.revision})
        self.stack = {"services": {
            "erp": {"image": "carbon/erp:" + self.revision, "environment": {"EXAMPLE": "runtime"}, "secrets": ["example"]},
            "ops": {"image": "carbon/ops:" + self.revision, "environment": {}, "secrets": [], "volumes": []},
        }}
        (self.runtime / "compose.json").write_text(json.dumps(self.stack))

    def prepare(self, mode="check"):
        return prepare(self.directory, mode, self.runtime, self.root)

    def test_prepare_uses_maintained_source_and_no_private_executable_mount(self):
        ops = self.prepare()["services"]["ops"]
        self.assertEqual(ops["command"], ["node", "--input-type=module", "-e", LOADER])
        self.assertNotIn("vitest", LOADER)
        self.assertIn("invoice-operator.server.ts", LOADER)
        self.assertEqual(ops["environment"]["INVOICE_OPERATOR_SCHEDULER_PAUSED"], "false")
        self.assertEqual(ops["secrets"], ["example"])
        self.assertEqual(len(ops["volumes"]), 1)

    def test_default_does_not_run_docker_or_any_operations(self):
        with patch("run_invoice_operator.subprocess.run") as launched, patch("run_invoice_operator.captured") as queried:
            run(self.directory, runtime=self.runtime, private_root=self.root)
        launched.assert_not_called()
        queried.assert_not_called()

    def test_rejects_revision_mismatch_and_public_inputs(self):
        private_write(self.directory / "operator.json", {"requiredRevision": "b" * 40})
        with self.assertRaisesRegex(ValueError, "revision"):
            self.prepare()
        private_write(self.directory / "operator.json", {"requiredRevision": self.revision})
        (self.directory / "operator.json").chmod(0o644)
        with self.assertRaisesRegex(ValueError, "0600"):
            self.prepare()

    def test_pins_actual_images_and_rejects_stale_running_app(self):
        stack = self.prepare()
        image = "sha256:" + "1" * 64
        ops = "sha256:" + "2" * 64
        with patch("run_invoice_operator.captured", side_effect=["container", image, image, ops]):
            pin_images(stack, ["docker", "compose"])
        self.assertEqual(stack["services"]["ops"]["image"], ops)
        with patch("run_invoice_operator.captured", side_effect=["container", image, ops, ops]), self.assertRaises(ValueError):
            pin_images(self.prepare(), ["docker", "compose"])

    def test_failed_setting_restore_keeps_scheduler_paused_until_recover(self):
        calls = []
        def command(command, **kwargs):
            calls.append(command)
            if "run" in command:
                private_write(self.directory / "checkpoint.json", {"restoreRequired": True})
            return SimpleNamespace(returncode=1 if "run" in command else 0)
        with patch("run_invoice_operator.pin_images"), patch("run_invoice_operator.captured", return_value="inngest"), patch("run_invoice_operator.subprocess.run", side_effect=command):
            with self.assertRaisesRegex(ValueError, "settings need recovery"):
                run(self.directory, "apply", True, self.runtime, self.root)
        self.assertFalse(any("start" in call for call in calls))
        self.assertTrue(json.loads((self.directory / "scheduler.json").read_text())["restoreRequired"])
        calls.clear()
        def recovered(command, **kwargs):
            calls.append(command)
            if "run" in command:
                private_write(self.directory / "checkpoint.json", {"restoreRequired": False})
            return SimpleNamespace(returncode=0)
        with patch("run_invoice_operator.pin_images"), patch("run_invoice_operator.subprocess.run", side_effect=recovered):
            run(self.directory, "recover", True, self.runtime, self.root)
        self.assertTrue(any("start" in call for call in calls))
        self.assertFalse(json.loads((self.directory / "scheduler.json").read_text())["restoreRequired"])

    def test_does_not_start_a_previously_paused_scheduler(self):
        with patch("run_invoice_operator.pin_images"), patch("run_invoice_operator.captured", return_value=""), patch("run_invoice_operator.subprocess.run", return_value=SimpleNamespace(returncode=0)) as launched:
            run(self.directory, "apply", True, self.runtime, self.root)
        self.assertFalse(any("start" in call.args[0] for call in launched.call_args_list))

    def test_recover_keeps_original_manifest_after_a_new_deployment(self):
        original = (self.directory / "operator.json").read_bytes()
        revision = "b" * 40
        (self.runtime / "revision").write_text(revision)
        for application in ("erp", "ops"):
            self.stack["services"][application]["image"] = "carbon/" + application + ":" + revision
        (self.runtime / "compose.json").write_text(json.dumps(self.stack))
        with self.assertRaisesRegex(ValueError, "exact deployed revision"):
            self.prepare("apply")
        with self.assertRaisesRegex(ValueError, "exact deployed revision"):
            self.prepare("check")
        recovered = self.prepare("recover")
        self.assertEqual(recovered["services"]["ops"]["environment"]["INVOICE_OPERATOR_REVISION"], revision)
        self.assertEqual((self.directory / "operator.json").read_bytes(), original)

    def test_failed_stop_records_recovery_before_any_app_operation(self):
        with patch("run_invoice_operator.pin_images"), patch("run_invoice_operator.captured", return_value="inngest"), patch("run_invoice_operator.subprocess.run", side_effect=subprocess.CalledProcessError(1, ["docker", "compose", "stop"])) as launched:
            with self.assertRaises(subprocess.CalledProcessError):
                run(self.directory, "apply", True, self.runtime, self.root)
        self.assertEqual(launched.call_count, 1)
        scheduler = json.loads((self.directory / "scheduler.json").read_text())
        self.assertTrue(scheduler["restoreRequired"])
        self.assertTrue(scheduler["wasRunning"])
        self.assertFalse((self.directory / "checkpoint.json").exists())

    def test_failed_runner_with_restored_settings_restores_scheduler(self):
        def command(command, **kwargs):
            if "run" in command:
                private_write(self.directory / "checkpoint.json", {"restoreRequired": False})
            return SimpleNamespace(returncode=1 if "run" in command else 0)
        with patch("run_invoice_operator.pin_images"), patch("run_invoice_operator.captured", return_value="inngest"), patch("run_invoice_operator.subprocess.run", side_effect=command) as launched:
            with self.assertRaisesRegex(ValueError, "operation failed"):
                run(self.directory, "apply", True, self.runtime, self.root)
        self.assertTrue(any("start" in call.args[0] for call in launched.call_args_list))
        self.assertFalse(json.loads((self.directory / "scheduler.json").read_text())["restoreRequired"])


if __name__ == "__main__":
    unittest.main()
