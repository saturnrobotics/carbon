"""Keep permission-denial tests representative of every owned runtime stack."""

from pathlib import Path
import unittest

import yaml


REPO = Path(__file__).resolve().parents[3]


class PostgresRuntimeTests(unittest.TestCase):
    def test_owned_stacks_disable_crashing_permission_hints_without_removing_extensions(self):
        for relative in (
            "packages/dev/docker/docker-compose.dev.yml",
            "contrib/deploying/simple-docker-caddy/docker-compose.prod.yml",
            "contrib/deploying/knowledge/compose.local.yaml",
            "contrib/deploying/gcp-tailscale/auth/oauth-evaluation/compose.yml",
        ):
            with self.subTest(stack=relative):
                stack = yaml.safe_load((REPO / relative).read_text())
                command = stack["services"]["postgres"].get("command", [])
                self.assertIn("supautils.hint_roles=", command)
                self.assertFalse(any("preload_libraries=" in argument for argument in command))

    def test_ci_exercises_the_same_permission_denial_configuration(self):
        workflow = yaml.safe_load((REPO / ".github/workflows/knowledge-check.yml").read_text())
        steps = workflow["jobs"]["runtime"]["steps"]
        start = next(step["run"] for step in steps if step.get("name") == "Start isolated synthetic PostgreSQL and Redis")
        self.assertIn("-c supautils.hint_roles=", start)
        self.assertNotIn("preload_libraries=", start)
        tests = next(step["run"] for step in steps if step.get("name") == "Runtime unit and integration tests")
        self.assertIn("python3 packages/knowledge/scripts/test_sql_runner.py", tests)


if __name__ == "__main__":
    unittest.main()
