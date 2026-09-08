"""Offline preparation tests: no real credentials or cloud mutations."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import prepare_release as prepare
import release_plan

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BASES = {"NODE_IMAGE": "node:22@sha256:" + "a" * 64,
         "NODE_SLIM_IMAGE": "node:22-slim@sha256:" + "b" * 64}
CONFIG = {"SOURCE_REPO_URL": "https://github.com/example/carbon", "PROJECT_ID": "example-project",
          "ERP_HOST": "erp.example.com", "MES_HOST": "mes.example.com", "SUPABASE_HOST": "api.example.com",
          "AUTH_ALLOWED_GOOGLE_DOMAIN": "example.com", "GOOGLE_CLIENT_SECRET": "synthetic-private-value"}


def materialize(value, repo):
    result = copy.deepcopy(value)
    for name, service in result["services"].items():
        for key in release_plan.BUILD_INPUTS:
            service["inputs"].setdefault(key, name + "-" + key)
    return result


def observation():
    return {"manifest": {"generation": 3, "services": {}}, "runtime_exists": True,
            "secret_versions": {name: prepare.secret_digest("synthetic-" + name) for name in prepare.APP_SECRETS}}


class PreparationTests(unittest.TestCase):
    def generate(self, config=None, observed=None):
        with patch.object(release_plan, "materialize_repository_inputs", side_effect=materialize):
            return prepare.desired_release(config or CONFIG, REPO, "c" * 40, observed or observation(), BASES)

    def test_complete_inventory_private_fingerprints_and_generation(self):
        desired = self.generate()
        self.assertEqual(set(desired["services"]), {"erp", "mes"})
        self.assertEqual(desired["generation"], 4)
        self.assertNotIn("synthetic-private-value", json.dumps(desired))
        self.assertNotIn("erp.example.com", json.dumps(desired))
        self.assertEqual(desired["base_images"], BASES)
        self.assertTrue(desired["maintenance_required"])

    def test_unchanged_release_is_noop_after_baseline(self):
        initial = self.generate()
        planned = prepare.plan_release(initial, observation()["manifest"])
        observed = observation()
        observed["manifest"] = {"generation": 4, "services": planned["services"],
                                "maintenance_fingerprint": initial["maintenance_fingerprint"]}
        desired = self.generate(observed=observed)
        result = prepare.plan_release(desired, observed["manifest"])
        self.assertEqual(result["deploy"], {})
        self.assertFalse(desired["maintenance_required"])
        changed = self.generate(config={**CONFIG, "PAYMENT_SYNC_COMPANY_ID": "synthetic-company"}, observed=observed)
        self.assertEqual(set(prepare.plan_release(changed, observed["manifest"])["deploy"]), {"erp"})
        self.assertFalse(changed["maintenance_required"])

    def test_unknown_existing_service_is_not_removed(self):
        observed = observation()
        observed["manifest"]["services"]["other"] = {}
        with self.assertRaisesRegex(ValueError, "unsupported managed services"):
            self.generate(observed=observed)

    def test_missing_manifest_is_not_a_fabricated_baseline(self):
        observed = observation()
        observed["manifest"] = {"generation": 0, "services": {}}
        desired = self.generate(observed=observed)
        self.assertTrue(desired["maintenance_required"])
        self.assertIn("baseline", " ".join(desired["maintenance_reasons"]))

    def test_oauth_change_requires_maintenance(self):
        first = self.generate()
        observed = observation()
        observed["manifest"]["maintenance_fingerprint"] = first["maintenance_fingerprint"]
        changed = self.generate(config={**CONFIG, "GOOGLE_CLIENT_SECRET": "changed-private-value"}, observed=observed)
        self.assertTrue(changed["maintenance_required"])

    def test_routing_and_domain_changes_require_maintenance(self):
        first = self.generate()
        observed = observation()
        observed["manifest"]["maintenance_fingerprint"] = first["maintenance_fingerprint"]
        for key in ("ERP_HOST", "MES_HOST", "SUPABASE_HOST", "AUTH_ALLOWED_GOOGLE_DOMAIN"):
            with self.subTest(key=key):
                changed = self.generate(config={**CONFIG, key: "changed.example.com"}, observed=observed)
                self.assertTrue(changed["maintenance_required"])

    def test_private_client_isolation_is_owned_by_maintenance(self):
        self.assertIn(prepare.HERE_REL + "private-client-isolation.sql", prepare.MAINTENANCE_PATHS)

    def test_preview_artifact_is_validated_before_cloud_access(self):
        cloud = Mock()
        (HERE / ".local").mkdir(exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(dir=HERE / ".local") as directory:
            output = Path(directory) / "release-plan.json"
            preview = output.with_name("release-preview.json")
            preview.symlink_to(REPO / "Makefile")
            with self.assertRaisesRegex(ValueError, "symlink"), patch.object(prepare, "observe") as observe, \
                 patch.object(prepare, "resolve_base_images", side_effect=AssertionError("No registry calls allowed")):
                prepare.prepare(CONFIG, REPO, "c" * 40, cloud, output)
            observe.assert_not_called()
            self.assertFalse(output.exists())

    def test_supplied_secret_uses_same_digest_as_observed_file(self):
        observed = observation()
        observed["secret_versions"]["resend_api_key"] = prepare.secret_digest("synthetic-token")
        left = self.generate(config={**CONFIG, "RESEND_API_KEY": "synthetic-token"}, observed=observed)
        right = self.generate(observed=observed)
        self.assertEqual(left["services"]["erp"]["secret_versions"]["resend_api_key"],
                         right["services"]["erp"]["secret_versions"]["resend_api_key"])

    def test_ssh_failure_is_not_first_install(self):
        cloud = Mock()
        cloud.c = {"VM_NAME": "example", "ZONE": "example-zone"}
        cloud.get.return_value = [{"name": "example"}]
        cloud.ssh.side_effect = subprocess.CalledProcessError(1, "ssh")
        with self.assertRaisesRegex(ValueError, "observe"):
            prepare.observe(cloud)
        cloud.provision.assert_not_called()

    def test_absent_vm_is_explicit_first_install(self):
        cloud = Mock()
        cloud.c = {"VM_NAME": "example", "ZONE": "example-zone"}
        cloud.get.return_value = []
        self.assertEqual(prepare.observe(cloud)["manifest"]["generation"], 0)
        cloud.ssh.assert_not_called()

    def test_private_artifact_is_atomic_and_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release-plan.json"
            prepare.write_private_json(path, {"test": 1})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            prepare.write_private_json(path, {"test": 2})
            self.assertEqual(json.loads(path.read_text()), {"test": 2})
            link = Path(directory) / "link.json"
            link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, "symlink"):
                prepare.write_private_json(link, {})
            self.assertEqual(json.loads(path.read_text()), {"test": 2})


if __name__ == "__main__":
    unittest.main()
