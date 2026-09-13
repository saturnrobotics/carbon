"""Public entry points and workspace identity must follow the Portal name."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]


class PortalNamingTests(unittest.TestCase):
    def test_workspace_entry_points_are_named_portal(self):
        for folder, name in (("apps/portal", "portal"), ("apps/portal-query", "portal-query"),
                             ("apps/portal-worker", "portal-worker"), ("apps/portal-actions", "portal-actions"),
                             ("packages/portal", "@carbon/portal")):
            with self.subTest(folder=folder):
                manifest = ROOT / folder / "package.json"
                self.assertTrue(manifest.is_file(), f"Missing renamed workspace {folder}")
                self.assertEqual(json.loads(manifest.read_text())["name"], name)

    def test_deployment_entry_points_are_named_portal(self):
        self.assertTrue((ROOT / "contrib/deploying/portal/deploy.py").is_file())
        self.assertTrue((ROOT / ".github/workflows/portal-check.yml").is_file())
        self.assertIn("deploy-portal:", (ROOT / "Makefile").read_text())


if __name__ == "__main__":
    unittest.main()
