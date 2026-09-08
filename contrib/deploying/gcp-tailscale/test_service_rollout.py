"""Routine rollout decisions must not widen into full-stack maintenance."""
import importlib.util
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("deploy", HERE / "deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class ServiceRolloutTests(unittest.TestCase):
    def test_erp_only_rollout_does_not_restart_mes_or_stateful_dependencies(self):
        commands = deploy.routine_host_actions({"deploy": {"erp": ["source changed"]}, "migrate": {}}, maintenance=False)
        flattened = " ".join(" ".join(command) for command in commands)
        self.assertIn("routine-apply", flattened)
        self.assertNotIn("mes", flattened)
        for service in ("postgres", "redis", "inngest", "gotrue", "edge-runtime"):
            self.assertNotIn(service, flattened)

    def test_migration_only_and_explicit_maintenance_take_distinct_paths(self):
        migration = deploy.routine_host_actions({"deploy": {}, "migrate": {"erp": ["schema compatible"]}}, maintenance=False)
        maintenance = deploy.routine_host_actions({"deploy": {}, "migrate": {}}, maintenance=True)
        self.assertEqual(migration[-1][-1], "routine-migrate")
        self.assertEqual(maintenance[-1][-1], "maintenance-apply")

    def test_cas_and_manual_configuration_drift_stop_before_promotion(self):
        plan = {"expected_generation": 4, "services": {"erp": {"observed_config_digest": "expected"}}}
        with self.assertRaisesRegex(ValueError, "generation"):
            deploy.verify_rollout_state(plan, {"generation": 3, "services": {}}, {"erp": "expected"})
        with self.assertRaisesRegex(ValueError, "configuration drift"):
            deploy.verify_rollout_state(plan, {"generation": 4, "services": {}}, {"erp": "manual-change"})


if __name__ == "__main__":
    unittest.main()
