"""Offline release-controller behavior. No provider calls are permitted."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("knowledge_release", HERE / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def plan(*, image="us-docker.pkg.dev/example/knowledge/web@sha256:" + "a" * 64):
    return {
        "schema_version": 1, "source_commit": "a" * 40, "expected_generation": 3, "generation": 4,
        "deploy": {"knowledge-web": ["source changed"]},
        "build_receipt": {"knowledge-web": {"image": image, "image_digest": image.rsplit("@", 1)[-1], "source_commit": "a" * 40}},
        "services": {"knowledge-web": {
            "kind": "service", "implementation_ready": True, "image": image,
            "service_account": "knowledge-web@example.iam.gserviceaccount.com",
            "environment": {
                "KNOWLEDGE_COMPANY_ID": "company-example",
                "KNOWLEDGE_MANUAL_SOURCE_JSON": '{"sourceId":"manuals","displayName":"Manual library"}',
                "KNOWLEDGE_RELEASE_PROFILE": "manual-v1",
                "KNOWLEDGE_QUERY_AUDIENCE": "query-audience",
                "KNOWLEDGE_QUERY_URL": "https://query.example",
                "KNOWLEDGE_WEB_IAP_AUDIENCE": "iap-audience",
                "KNOWLEDGE_WEB_ORIGIN": "https://portal.example",
                "KNOWLEDGE_WORKER_AUDIENCE": "worker-audience",
                "KNOWLEDGE_WORKER_URL": "https://worker.example",
            },
            "secrets": {},
            "resources": {"cpu": "1", "memory": "512Mi"}, "max_instances": 2,
            "concurrency": 20, "network": "knowledge-private",
            "subnetwork": "knowledge-runtime", "egress": "all-traffic",
        }},
    }


class ReleaseControllerTests(unittest.TestCase):
    def test_retention_job_requires_its_narrow_runtime_configuration(self):
        self.assertEqual(release.UNITS["knowledge-retention"], "job")
        self.assertEqual(
            release.REQUIRED_ENVIRONMENT["knowledge-retention"],
            {"KNOWLEDGE_OBJECT_BUCKET"},
        )

    def test_manual_release_rejects_deferred_units_and_configuration(self):
        self.assertNotIn("knowledge-actions", release.UNITS)
        candidate = plan()
        candidate["services"]["knowledge-web"]["environment"]["KNOWLEDGE_ACTIONS_URL"] = "https://actions.example"
        with self.assertRaisesRegex(ValueError, "deferred runtime configuration"):
            release.validate_plan(candidate)
        self.assertEqual(
            release.REQUIRED_SECRETS["knowledge-retention"],
            {"KNOWLEDGE_MAINTENANCE_DATABASE_URL"},
        )

    def test_noop_issues_no_mutations(self):
        self.assertEqual(release.select_mutations({**plan(), "deploy": {}}, {"generation": 3, "services": {}}, {}), [])

    def test_rejects_mutable_image_and_secret_versions(self):
        with self.assertRaisesRegex(ValueError, "immutable image digest"):
            release.validate_plan(plan(image="us-docker.pkg.dev/example/knowledge/web:latest"))
        candidate = plan()
        candidate["services"]["knowledge-web"]["secrets"] = {
            "UNEXPECTED": "projects/example/secrets/knowledge-db-url/versions/latest"
        }
        with self.assertRaisesRegex(ValueError, "pinned secret version"):
            release.validate_plan(candidate)

    def test_rejects_browser_or_parser_secrets_and_missing_direct_vpc_egress(self):
        candidate = plan()
        candidate["services"]["knowledge-web"]["secrets"] = {
            "UNEXPECTED": "projects/example/secrets/knowledge-db-url/versions/7"
        }
        with self.assertRaisesRegex(ValueError, "must not receive runtime secrets"):
            release.validate_plan(candidate)
        candidate = plan()
        candidate["services"]["knowledge-web"].pop("network")
        with self.assertRaisesRegex(ValueError, "Direct VPC egress"):
            release.validate_plan(candidate)

    def test_rejects_a_selected_image_without_its_verified_build_receipt(self):
        candidate = plan()
        candidate["build_receipt"] = {}
        with self.assertRaisesRegex(ValueError, "verified build receipt"):
            release.validate_plan(candidate)

    def test_rejects_unimplemented_service_and_manual_revision_drift(self):
        unready = plan()
        unready["services"]["knowledge-web"]["implementation_ready"] = False
        with self.assertRaisesRegex(ValueError, "not implementation-ready"):
            release.validate_plan(unready)
        expected = {"generation": 3, "services": {"knowledge-web": {"revision_digest": "expected"}}}
        with self.assertRaisesRegex(ValueError, "configuration drift"):
            release.select_mutations(plan(), expected, {"knowledge-web": "hand-edited"})

    def test_selects_only_affected_service_and_stages_before_promotion(self):
        expected = {"generation": 3, "services": {"knowledge-web": {"revision_digest": "old"}, "knowledge-query": {"revision_digest": "query"}}}
        changes = release.select_mutations(plan(), expected, {"knowledge-web": "old", "knowledge-query": "query"})
        self.assertEqual([change["name"] for change in changes], ["knowledge-web"])
        self.assertEqual(changes[0]["strategy"], "stage-then-promote")

    def test_renders_direct_vpc_egress_in_the_revision_spec(self):
        rendered = release.revision_document("knowledge-web", plan()["services"]["knowledge-web"], "revision")
        annotations = rendered["spec"]["template"]["metadata"]["annotations"]
        self.assertEqual(annotations["run.googleapis.com/vpc-access-egress"], "all-traffic")
        self.assertEqual(
            json.loads(annotations["run.googleapis.com/network-interfaces"]),
            [{"network": "knowledge-private", "subnetwork": "knowledge-runtime"}],
        )

    def test_promotes_selected_service_after_no_traffic_stage_and_persists_manifest(self):
        class FakeGcloud:
            def __init__(self): self.calls = []; self.describes = 0
            def call(self, args, *, capture=False):
                self.calls.append(args)
                if "describe" in args:
                    self.describes += 1
                    if self.describes == 1:
                        return json.dumps({"spec": {"template": {"metadata": {"labels": {"knowledge.carbon/revision-digest": "old"}}}}, "status": {"traffic": [{"revisionName": "knowledge-web-old", "percent": 100}]}})
                    return json.dumps({"status": {"url": "https://knowledge-web.example", "latestReadyRevisionName": "knowledge-web-new", "conditions": [{"type": "Ready", "status": "True"}]}})
                if args[:4] == ["gcloud", "auth", "print-identity-token", "--audiences=https://knowledge-web.example"]:
                    return "synthetic-token\n"
                return ""
        current = {"generation": 3, "services": {"knowledge-web": {"revision_digest": "old"}}}
        with tempfile.TemporaryDirectory() as directory:
            adapter = FakeGcloud()
            promoted = release.promote(plan(), current, project="example", region="us-east1", manifest=Path(directory) / "manifest.json", adapter=adapter)
            self.assertEqual([entry["name"] for entry in promoted], ["knowledge-web"])
            staged = next(call for call in adapter.calls if "replace" in call)
            self.assertIn("--no-traffic", staged)
            self.assertTrue(any(call[0] == "curl" and call[-1].endswith("/health") for call in adapter.calls))
            self.assertTrue(any("update-traffic" in call for call in adapter.calls))
            saved = json.loads((Path(directory) / "manifest.json").read_text())
            self.assertEqual(saved["generation"], 4)
            self.assertEqual(saved["services"]["knowledge-web"]["deployed_revision"], "knowledge-web-new")

    def test_failed_health_restores_only_the_selected_service_prior_revision(self):
        class FailingHealthGcloud:
            def __init__(self): self.calls = []; self.describes = 0
            def call(self, args, *, capture=False):
                self.calls.append(args)
                if "describe" in args:
                    self.describes += 1
                    if self.describes == 1:
                        return json.dumps({"spec": {"template": {"metadata": {"labels": {"knowledge.carbon/revision-digest": "old"}}}}, "status": {"traffic": [{"revisionName": "knowledge-web-old", "percent": 100}]}})
                    return json.dumps({"status": {"url": "https://knowledge-web.example", "conditions": [{"type": "Ready", "status": "True"}]}})
                if args[0] == "curl":
                    raise release.subprocess.CalledProcessError(22, args)
                if args[:4] == ["gcloud", "auth", "print-identity-token", "--audiences=https://knowledge-web.example"]:
                    return "synthetic-token\n"
                return ""
        adapter = FailingHealthGcloud()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(release.subprocess.CalledProcessError):
                release.promote(plan(), {"generation": 3, "services": {"knowledge-web": {"revision_digest": "old"}}}, project="example", region="us-east1", manifest=Path(directory) / "manifest.json", adapter=adapter)
        self.assertTrue(any("--to-revisions=knowledge-web-old=100" in call for call in adapter.calls))


if __name__ == "__main__":
    unittest.main()
