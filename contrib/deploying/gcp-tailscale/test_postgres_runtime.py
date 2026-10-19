"""Keep permission-denial tests representative of every owned runtime stack."""

import importlib
from pathlib import Path
import sys
import tempfile
import unittest

import yaml


REPO = Path(__file__).resolve().parents[3]


class PostgresRuntimeTests(unittest.TestCase):
    def test_owned_stacks_disable_crashing_permission_hints_without_removing_extensions(self):
        for relative in (
            "packages/dev/docker/docker-compose.dev.yml",
            "contrib/deploying/simple-docker-caddy/docker-compose.prod.yml",
            "contrib/deploying/portal/compose.local.yaml",
            "contrib/deploying/gcp-tailscale/auth/oauth-evaluation/compose.yml",
        ):
            with self.subTest(stack=relative):
                stack = yaml.safe_load((REPO / relative).read_text())
                command = stack["services"]["postgres"].get("command", [])
                self.assertIn("supautils.hint_roles=", command)
                self.assertFalse(any("preload_libraries=" in argument for argument in command))

    def test_ci_exercises_the_same_permission_denial_configuration(self):
        workflow = yaml.safe_load((REPO / ".github/workflows/portal-check.yml").read_text())
        steps = workflow["jobs"]["runtime"]["steps"]
        start = next(step["run"] for step in steps if step.get("name") == "Start isolated synthetic PostgreSQL and Redis")
        self.assertIn("-c supautils.hint_roles=", start)
        self.assertNotIn("preload_libraries=", start)
        tests = next(step["run"] for step in steps if step.get("name") == "Runtime unit and integration tests")
        self.assertIn("python3 packages/portal/scripts/test_sql_runner.py", tests)


    def test_rendered_private_listeners_keep_the_permission_denial_configuration(self):
        # Both ingress modes publish PostgreSQL privately from the same rendered service.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        render = importlib.import_module("render")
        from test_render import private_lb_config
        tailscale = {**{key: value for key, value in private_lb_config().items()
                        if key not in {"INGRESS_MODE", "NETWORK", "SUBNET", "SERVICE_ACCOUNT", "INGRESS_ALLOWLIST"}},
                     "TAILSCALE_IP": "100.72.10.8"}
        for label, config in (("tailscale", tailscale), ("private-lb", private_lb_config())):
            with self.subTest(mode=label), tempfile.TemporaryDirectory() as state:
                stack, _ = render.render(config, REPO, Path(state) / "prepared", Path(state), materialize=False)
                postgres = stack["services"]["postgres"]
                self.assertIn("supautils.hint_roles=", postgres["command"])
                self.assertFalse(any("preload_libraries=" in argument for argument in postgres["command"]))
                self.assertIn("ssl=on", postgres["command"])
                self.assertEqual(postgres["ports"], [{"target": 5432, "published": "5432", "host_ip": "10.73.8.2", "protocol": "tcp"}])


if __name__ == "__main__":
    unittest.main()
