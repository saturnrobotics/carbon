"""Static foundation contracts that complement terraform validate offline."""
from pathlib import Path
import json
import unittest

HERE = Path(__file__).resolve().parent


class FoundationTests(unittest.TestCase):
    def setUp(self):
        self.text = "\n".join(path.read_text() for path in HERE.glob("*.tf"))
        self.compact = "".join(self.text.split())

    def test_iap_is_direct_group_scoped_and_no_service_is_public(self):
        self.assertIn('google_iap_web_cloud_run_service_iam_binding', self.text)
        self.assertIn('roles/iap.httpsResourceAccessor', self.text)
        self.assertIn('iap_enabled=true', self.compact)
        self.assertNotIn('allUsers', self.text)
        self.assertNotIn('allAuthenticatedUsers', self.text)

    def test_runtime_identities_are_separate_and_never_project_runtime_admins(self):
        self.assertIn('runtime_identities = toset(["deployment", "web", "query", "ingest", "parser", "migration", "maintenance"])', self.text)
        self.assertNotIn('roles/run.admin', self.text)
        self.assertNotIn('roles/owner', self.text)

    def test_private_storage_and_networking_have_no_public_data_path(self):
        self.assertIn('public_access_prevention="enforced"', self.compact)
        self.assertIn('uniform_bucket_level_access=true', self.compact)
        self.assertIn('egress="ALL_TRAFFIC"', self.compact)
        self.assertIn('transit_encryption_mode="SERVER_AUTHENTICATION"', self.compact)

    def test_parser_and_ingest_have_only_the_object_and_job_access_they_use(self):
        identity = (HERE / "identity.tf").read_text()
        storage = (HERE / "storage.tf").read_text()
        self.assertNotIn('parser = ["knowledge-parser-key"]', identity)
        self.assertIn('google_storage_bucket_iam_member" "parser_write', storage)
        self.assertIn('google_storage_bucket_iam_member" "ingest_read', storage)
        self.assertIn('roles/run.invoker', identity)
        self.assertIn("knowledge-parser", identity)
        self.assertIn('"run.operations.get"', identity)
        self.assertNotIn('runtime["query"]', storage)

    def test_maintenance_alone_can_delete_retained_objects(self):
        identity = (HERE / "identity.tf").read_text()
        storage = (HERE / "storage.tf").read_text()
        self.assertIn('maintenance = ["knowledge-maintenance-db-url"]', identity)
        self.assertIn('permissions = ["storage.objects.delete"]', storage)
        self.assertIn('runtime["maintenance"]', storage)
        self.assertNotIn('runtime["ingest"]', storage.split('permissions = ["storage.objects.delete"]', 1)[1])
        self.assertIn('jobs/knowledge-retention', identity)
        self.assertIn('resource "google_cloud_scheduler_job" "retention"', self.text)

    def test_content_free_operational_alerts_cover_critical_stages(self):
        monitoring = (HERE / "monitoring.tf").read_text()
        for signal in ("authentication", "source", "model", "cache", "indexing", "retention"):
            with self.subTest(signal=signal):
                self.assertIn(f'jsonPayload.stage=\\"{signal}\\"', monitoring)
        self.assertIn("database_connection_utilization_metric_type", monitoring)

    def test_revision_specs_are_controller_owned_and_secrets_are_not_latest(self):
        self.assertIn('revision fields are controller-owned', self.text)
        self.assertIn('lifecycle {', self.text)
        self.assertNotIn('versions/latest', self.text)

    def test_implemented_units_have_pruned_production_runtime_images(self):
        expected_commands = {
            "web": 'CMD ["node", "node_modules/@react-router/serve/bin.js", "build/server/index.js"]',
            "query": 'CMD ["node", "dist/index.js"]',
            "ingest": 'CMD ["node", "dist/index.js"]',
            "schema": 'CMD ["node", "schema/migrate.mjs"]',
            "retention": 'CMD ["node", "dist/retention-job.js"]',
        }
        for unit, command in expected_commands.items():
            dockerfile = (HERE / f"Dockerfile.{unit}").read_text()
            with self.subTest(unit=unit):
                self.assertNotIn("exit 78", dockerfile)
                self.assertIn("turbo@2.9.6 prune", dockerfile)
                self.assertIn("deploy --prod --legacy --ignore-scripts", dockerfile)
                self.assertIn(command, dockerfile)

    def test_parser_image_is_a_finite_job_not_the_ingest_server(self):
        dockerfile = (HERE / "Dockerfile.parser").read_text()
        self.assertNotIn("exit 78", dockerfile)
        self.assertIn('CMD ["node", "dist/parser-job.js"]', dockerfile)
        self.assertIn("poppler-utils", dockerfile)
        self.assertIn("tesseract-ocr", dockerfile)

    def test_web_declares_every_externalized_runtime_import(self):
        manifest = json.loads((HERE.parents[2] / "apps/knowledge/package.json").read_text())
        self.assertEqual(manifest["dependencies"].get("zod"), "catalog:")


if __name__ == "__main__":
    unittest.main()
