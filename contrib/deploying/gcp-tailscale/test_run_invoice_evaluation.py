import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import run_invoice_evaluation as evaluation


class InvoiceEvaluationRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.directory = self.root / "run"
        self.directory.mkdir(mode=0o700)
        (self.directory / "live.json").write_text("{}")
        (self.directory / "live.json").chmod(0o600)
        (self.directory / "fixtures.json").write_text("[]")
        self.runtime = self.root / "compose.json"
        self.runtime.write_text(json.dumps({"services": {
            "ops": {"image": "example/ops:committed-revision", "environment": {"OPS": "true"}, "volumes": [], "secrets": ["db"]},
            "erp": {"environment": {"INVOICE_INTAKE_ENABLED": "true"}, "secrets": ["db", "storage"]}
        }}))
        self.root_patch = patch.object(evaluation, "PRIVATE_ROOT", self.root)
        self.root_patch.start()

    def tearDown(self):
        self.root_patch.stop()
        self.temporary.cleanup()

    def test_dry_run_preserves_deployed_revision_and_never_starts_a_process(self):
        with patch.object(evaluation.subprocess, "run") as run:
            evaluation.run_evaluation(self.directory, runtime=self.runtime)
        run.assert_not_called()
        output = self.directory / "evaluation-compose.json"
        ops = json.loads(output.read_text())["services"]["ops"]
        self.assertEqual(ops["image"], "example/ops:committed-revision")
        self.assertEqual(ops["secrets"], ["db", "storage"])
        self.assertEqual(ops["environment"]["INVOICE_EVAL_LIVE"], "true")
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_restarts_previously_running_scheduler_after_failed_evaluation(self):
        outcomes = [subprocess.CompletedProcess([], 0, "inngest\n"), subprocess.CompletedProcess([], 0),
                    subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0)]
        with patch.object(evaluation.subprocess, "run", side_effect=outcomes) as run:
            with self.assertRaisesRegex(ValueError, "did not pass"):
                evaluation.run_evaluation(self.directory, True, self.runtime)
        self.assertEqual(run.call_args_list[1].args[0][-2:], ["stop", "inngest"])
        self.assertEqual(run.call_args_list[-1].args[0][-2:], ["start", "inngest"])

    def test_leaves_an_already_stopped_scheduler_stopped(self):
        with patch.object(evaluation.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0, ""), subprocess.CompletedProcess([], 0)]) as run:
            evaluation.run_evaluation(self.directory, True, self.runtime)
        self.assertEqual(run.call_count, 2)
        self.assertEqual((self.directory / "live.log").stat().st_mode & 0o777, 0o600)

    def test_rejects_public_configuration_before_any_process(self):
        (self.directory / "live.json").chmod(0o644)
        with patch.object(evaluation.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "0600"):
                evaluation.run_evaluation(self.directory, True, self.runtime)
        run.assert_not_called()

    def test_rejects_a_directory_outside_private_root(self):
        with patch.object(evaluation, "PRIVATE_ROOT", self.root / "other"):
            with self.assertRaisesRegex(ValueError, "private subdirectory"):
                evaluation.run_evaluation(self.directory, True, self.runtime)

    def test_attempts_scheduler_recovery_if_stop_fails(self):
        outcomes = [subprocess.CompletedProcess([], 0, "inngest\n"), subprocess.CalledProcessError(1, "stop"), subprocess.CompletedProcess([], 0)]
        with patch.object(evaluation.subprocess, "run", side_effect=outcomes) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                evaluation.run_evaluation(self.directory, True, self.runtime)
        self.assertEqual(run.call_args_list[-1].args[0][-2:], ["start", "inngest"])


if __name__ == "__main__":
    unittest.main()
