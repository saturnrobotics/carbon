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


def observed_web_shell(*, iap="true"):
    """The knowledge-web Service as Terraform leaves it: IAP and ingress are service annotations."""
    annotations = {"run.googleapis.com/ingress": "all", "run.googleapis.com/operation-id": "synthetic"}
    if iap is not None:
        annotations["run.googleapis.com/iap-enabled"] = iap
    return {
        "metadata": {"name": "knowledge-web", "annotations": annotations},
        "spec": {"template": {"metadata": {"labels": {"knowledge.carbon/revision-digest": "old"}}}},
        "status": {"traffic": [{"revisionName": "knowledge-web-old", "percent": 100}]},
    }


def foundation_outputs(**overrides):
    audiences = {
        "knowledge-web": "/projects/123456789/locations/us-east1/services/knowledge-web",
        "knowledge-query": "https://knowledge-query-123456789.us-east1.run.app",
        "knowledge-ingest": "https://knowledge-ingest-123456789.us-east1.run.app",
        "knowledge-actions": "https://knowledge-actions-123456789.us-east1.run.app",
        **overrides,
    }
    return {"service_audiences": {"sensitive": False, "type": ["map", "string"], "value": audiences}}


class ReleaseControllerTests(unittest.TestCase):
    def test_audiences_come_from_the_foundation_outputs_and_drift_is_refused(self):
        candidate = plan()
        for variable in ("KNOWLEDGE_WEB_IAP_AUDIENCE", "KNOWLEDGE_QUERY_AUDIENCE", "KNOWLEDGE_WORKER_AUDIENCE"):
            candidate["services"]["knowledge-web"]["environment"].pop(variable)
        with self.assertRaisesRegex(ValueError, "missing mandatory runtime configuration: KNOWLEDGE_QUERY_AUDIENCE"):
            release.validate_plan(candidate)
        filled = release.apply_foundation_audiences(candidate, foundation_outputs())
        release.validate_plan(filled)
        environment = filled["services"]["knowledge-web"]["environment"]
        self.assertEqual(environment["KNOWLEDGE_WEB_IAP_AUDIENCE"], "/projects/123456789/locations/us-east1/services/knowledge-web")
        self.assertEqual(environment["KNOWLEDGE_QUERY_AUDIENCE"], "https://knowledge-query-123456789.us-east1.run.app")
        self.assertEqual(environment["KNOWLEDGE_WORKER_AUDIENCE"], "https://knowledge-ingest-123456789.us-east1.run.app")
        drifted = plan()
        with self.assertRaisesRegex(ValueError, "knowledge-web KNOWLEDGE_[A-Z_]+ differs from the foundation output .*--override-audiences"):
            release.apply_foundation_audiences(drifted, foundation_outputs())
        kept = release.apply_foundation_audiences(plan(), foundation_outputs(), override=True)
        self.assertEqual(kept["services"]["knowledge-web"]["environment"]["KNOWLEDGE_QUERY_AUDIENCE"], "query-audience")
        with self.assertRaisesRegex(ValueError, "lack an audience for: knowledge-ingest"):
            release.apply_foundation_audiences(plan(), {"service_audiences": {"value": {"knowledge-web": "w", "knowledge-query": "q"}}})
        with self.assertRaisesRegex(ValueError, "service_audiences"):
            release.apply_foundation_audiences(plan(), {"runtime_service_accounts": {"value": {}}})
        self.assertEqual(release.AUDIENCE_ENVIRONMENT["knowledge-ingest"], {"KNOWLEDGE_IDENTITY_AUDIENCE": "knowledge-query"})

    def test_web_replacement_keeps_the_foundation_owned_iap_annotation(self):
        rendered = release.revision_document("knowledge-web", plan()["services"]["knowledge-web"], "revision", observed_web_shell())
        self.assertEqual(rendered["metadata"]["annotations"], {"run.googleapis.com/iap-enabled": "true", "run.googleapis.com/ingress": "all"})
        for observed in (None, observed_web_shell(iap=None), observed_web_shell(iap="false")):
            with self.assertRaisesRegex(ValueError, "foundation shell with IAP enabled is not applied"):
                release.revision_document("knowledge-web", plan()["services"]["knowledge-web"], "revision", observed)
        query = dict(plan()["services"]["knowledge-web"], kind="service")
        self.assertNotIn("annotations", release.revision_document("knowledge-query", query, "revision", None)["metadata"])

    def test_missing_web_shell_refuses_promotion_before_any_write(self):
        class NoShellGcloud:
            def __init__(self): self.calls = []
            def call(self, args, *, capture=False):
                self.calls.append(args)
                if "describe" in args:
                    raise release.subprocess.CalledProcessError(1, args)
                return ""
        adapter = NoShellGcloud()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "foundation shell with IAP enabled"):
                release.promote(plan(), {"generation": 3, "services": {}}, project="example", region="us-east1", manifest=Path(directory) / "manifest.json", adapter=adapter)
            self.assertFalse((Path(directory) / "manifest.json").exists())
        self.assertFalse(any("replace" in call for call in adapter.calls))

    def test_only_database_units_carry_the_source_database_client_tag(self):
        self.assertEqual(release.DATABASE_UNITS, {"knowledge-query", "knowledge-ingest", "knowledge-schema", "knowledge-retention"})
        query = dict(plan()["services"]["knowledge-web"], kind="service")
        interfaces = json.loads(release.revision_document("knowledge-query", query, "revision")["spec"]["template"]["metadata"]["annotations"]["run.googleapis.com/network-interfaces"])
        self.assertEqual(interfaces, [{"network": "knowledge-private", "subnetwork": "knowledge-runtime", "tags": ["knowledge-source-database-client"]}])
        job = dict(plan()["services"]["knowledge-web"], kind="job")
        interfaces = json.loads(release.revision_document("knowledge-parser", job, "revision")["spec"]["template"]["template"]["metadata"]["annotations"]["run.googleapis.com/network-interfaces"])
        self.assertEqual(interfaces, [{"network": "knowledge-private", "subnetwork": "knowledge-runtime"}])

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

    def test_live_source_registry_is_admitted_on_the_query_unit_alone(self):
        registry = json.dumps({"version": 1, "sources": [{"id": "carbon-source", "kind": "carbon", "origin": "https://erp.example", "audience": "erp-receiver-audience"}]})
        self.assertEqual(release.OPTIONAL_ENVIRONMENT, {"knowledge-query": {"KNOWLEDGE_SOURCES_JSON"}})
        # Optional, so the query unit is valid with it and valid without it.
        release.validate_plan(database_plan())
        admitted = database_plan()
        admitted["services"]["knowledge-query"]["environment"]["KNOWLEDGE_SOURCES_JSON"] = registry
        release.validate_plan(admitted)
        for unit in ("knowledge-web", "knowledge-ingest"):
            candidate = database_plan(unit) if unit in release.DATABASE_UNITS else plan()
            candidate["services"][unit]["environment"]["KNOWLEDGE_SOURCES_JSON"] = registry
            with self.assertRaisesRegex(ValueError, "deferred runtime configuration: KNOWLEDGE_SOURCES_JSON"):
                release.validate_plan(candidate)

    def test_rejects_a_registry_the_query_service_would_refuse_to_boot_on(self):
        source = {"id": "carbon-source", "kind": "carbon", "origin": "https://erp.example", "audience": "erp-receiver-audience"}
        for reason, registry in (
            ("not JSON", "{"),
            ("no version", json.dumps({"sources": [source]})),
            ("an unknown top-level field", json.dumps({"version": 1, "sources": [source], "default": "carbon-source"})),
            ("an unknown source field", json.dumps({"version": 1, "sources": [dict(source, token="secret")]})),
            ("a missing source field", json.dumps({"version": 1, "sources": [{"id": "carbon-source", "kind": "carbon", "origin": "https://erp.example"}]})),
            ("an empty id", json.dumps({"version": 1, "sources": [dict(source, id="")]})),
        ):
            candidate = database_plan()
            candidate["services"]["knowledge-query"]["environment"]["KNOWLEDGE_SOURCES_JSON"] = registry
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, "strict live-source registry"):
                release.validate_plan(candidate)
        for origin in ("http://erp.example", "https://user:secret@erp.example", "https://erp.example/knowledge", "https://erp.example/?source=carbon", "not a url"):
            candidate = database_plan()
            candidate["services"]["knowledge-query"]["environment"]["KNOWLEDGE_SOURCES_JSON"] = json.dumps({"version": 1, "sources": [dict(source, origin=origin)]})
            with self.subTest(origin=origin), self.assertRaisesRegex(ValueError, "bare https URL without credentials"):
                release.validate_plan(candidate)
        duplicated = database_plan()
        duplicated["services"]["knowledge-query"]["environment"]["KNOWLEDGE_SOURCES_JSON"] = json.dumps({"version": 1, "sources": [source, dict(source, origin="https://other.example")]})
        with self.assertRaisesRegex(ValueError, "two sources under one ID"):
            release.validate_plan(duplicated)

    def test_rejects_a_source_kind_this_release_does_not_ship(self):
        self.assertEqual(release.SOURCE_REGISTRY_KINDS, {"carbon"})
        for kind in ("kanban", "engineering", "crm", "sharepoint"):
            candidate = database_plan()
            candidate["services"]["knowledge-query"]["environment"]["KNOWLEDGE_SOURCES_JSON"] = json.dumps({"version": 1, "sources": [{"id": "source", "kind": kind, "origin": "https://source.example", "audience": "audience"}]})
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, f"does not ship: {kind}"):
                release.validate_plan(candidate)

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
        rendered = release.revision_document("knowledge-web", plan()["services"]["knowledge-web"], "revision", observed_web_shell())
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
                        return json.dumps(observed_web_shell())
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
                        return json.dumps(observed_web_shell())
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


FIRST, MIDDLE, LAST = "20260908000245_knowledge-foundation", "20260908014537_retention-recovery", "20260908050421_ingest-source-visibility-execute"


def database_plan(unit="knowledge-query", *, minimum=FIRST, maximum=LAST):
    """A plan selecting one database unit with a declared compatible migration window."""
    image = f"us-docker.pkg.dev/example/knowledge/{unit}@sha256:" + "b" * 64
    candidate = plan()
    spec = dict(candidate["services"].pop("knowledge-web"), kind=release.UNITS[unit], image=image)
    spec["service_account"] = f"{unit}@example.iam.gserviceaccount.com"
    spec["environment"] = {key: "value" for key in release.REQUIRED_ENVIRONMENT[unit]}
    if "KNOWLEDGE_MANUAL_SOURCE_JSON" in spec["environment"]:
        spec["environment"]["KNOWLEDGE_MANUAL_SOURCE_JSON"] = '{"sourceId":"manuals","displayName":"Manual library"}'
    if "KNOWLEDGE_RELEASE_PROFILE" in spec["environment"]:
        spec["environment"]["KNOWLEDGE_RELEASE_PROFILE"] = "manual-v1"
    spec["secrets"] = {key: f"projects/example/secrets/{key.lower().replace('_', '-')}/versions/3" for key in release.REQUIRED_SECRETS[unit]}
    spec["migrations"] = {"minimum": minimum, "maximum": maximum}
    candidate["services"] = {unit: spec}
    candidate["deploy"] = {unit: ["source changed"]}
    candidate["build_receipt"] = {unit: {"image": image, "image_digest": image.rsplit("@", 1)[-1], "source_commit": "a" * 40}}
    return candidate


def ledger(*names):
    return {"schema_version": 1, "names": list(names)}


class MigrationCompatibilityTests(unittest.TestCase):
    def test_database_units_declare_a_window_and_credential_free_units_cannot(self):
        release.validate_plan(database_plan())
        for unit in sorted(release.DATABASE_UNITS):
            with self.subTest(unit=unit):
                candidate = database_plan(unit)
                release.validate_plan(candidate)
                candidate["services"][unit].pop("migrations")
                with self.assertRaisesRegex(ValueError, f"{unit} requires migrations.minimum and migrations.maximum"):
                    release.validate_plan(candidate)
        for window in ({"minimum": FIRST}, {"minimum": FIRST, "maximum": "v2"}, {"minimum": FIRST, "maximum": LAST, "extra": 1}, {"minimum": 1, "maximum": LAST}):
            with self.subTest(window=window):
                candidate = database_plan()
                candidate["services"]["knowledge-query"]["migrations"] = window
                with self.assertRaisesRegex(ValueError, "requires migrations.minimum and migrations.maximum"):
                    release.validate_plan(candidate)
        with self.assertRaisesRegex(ValueError, "minimum is newer than migrations.maximum"):
            release.validate_plan(database_plan(minimum=LAST, maximum=FIRST))
        web = plan()
        web["services"]["knowledge-web"]["migrations"] = {"minimum": FIRST, "maximum": LAST}
        with self.assertRaisesRegex(ValueError, "knowledge-web holds no database credential"):
            release.validate_plan(web)

    def test_ledger_head_is_the_greatest_applied_name_and_malformed_observations_are_refused(self):
        self.assertEqual(release.ledger_head(ledger(MIDDLE, FIRST, LAST)), LAST)
        # The runner records file names with their `.sql` suffix; a verbatim export normalizes to the bare name.
        self.assertEqual(release.ledger_head(ledger(FIRST + ".sql", MIDDLE + ".sql")), MIDDLE)
        self.assertIsNone(release.ledger_head(ledger()))
        for observation in ({"names": [FIRST]}, {"schema_version": 1, "names": "x"}, ledger("foundation.sql"), ledger(FIRST + ".SQL"), ledger(7)):
            with self.subTest(observation=observation), self.assertRaisesRegex(ValueError, "Schema ledger observation"):
                release.ledger_head(observation)

    def test_promotion_requires_the_ledger_head_inside_the_selected_window(self):
        current = {"generation": 3, "services": {}}
        inside = database_plan(minimum=FIRST, maximum=MIDDLE)
        self.assertEqual(release.check_migration_compatibility(inside, ledger(FIRST, MIDDLE)), {"knowledge-query": MIDDLE})
        self.assertEqual([m["name"] for m in release.select_mutations(inside, current, {}, ledger(FIRST, MIDDLE))], ["knowledge-query"])
        with self.assertRaisesRegex(ValueError, "requires --schema-ledger"):
            release.select_mutations(inside, current, {})
        with self.assertRaisesRegex(ValueError, f"requires migration {MIDDLE} but the ledger head is {FIRST}; run the schema job first"):
            release.select_mutations(database_plan(minimum=MIDDLE, maximum=LAST), current, {}, ledger(FIRST))
        with self.assertRaisesRegex(ValueError, f"supports migrations up to {MIDDLE} but the ledger head is {LAST}"):
            release.select_mutations(inside, current, {}, ledger(FIRST, MIDDLE, LAST))
        with self.assertRaisesRegex(ValueError, "cannot be promoted before the schema job applies the first"):
            release.select_mutations(inside, current, {}, ledger())
        self.assertEqual(release.check_migration_compatibility(database_plan("knowledge-schema"), ledger()), {"knowledge-schema": None})
        with self.assertRaisesRegex(ValueError, "knowledge-schema supports migrations up to"):
            release.check_migration_compatibility(database_plan("knowledge-schema", minimum=FIRST, maximum=MIDDLE), ledger(LAST))
        self.assertEqual(release.check_migration_compatibility(plan(), None), {})

    def test_promote_checks_the_ledger_before_any_write_and_records_the_window(self):
        class RecordingGcloud:
            def __init__(self): self.calls = []
            def call(self, args, *, capture=False):
                self.calls.append(args)
                if "describe" in args:
                    return json.dumps({"metadata": {"generation": 9}})
                return ""
        candidate = database_plan("knowledge-retention", minimum=MIDDLE, maximum=LAST)
        with tempfile.TemporaryDirectory() as directory:
            adapter = RecordingGcloud()
            with self.assertRaisesRegex(ValueError, "run the schema job first"):
                release.promote(candidate, {"generation": 3, "services": {}}, project="example", region="us-east1", manifest=Path(directory) / "manifest.json", adapter=adapter, ledger=ledger(FIRST))
            self.assertFalse(any("replace" in call for call in adapter.calls))
            self.assertFalse((Path(directory) / "manifest.json").exists())
            release.promote(candidate, {"generation": 3, "services": {}}, project="example", region="us-east1", manifest=Path(directory) / "manifest.json", adapter=adapter, ledger=ledger(FIRST, MIDDLE))
            saved = json.loads((Path(directory) / "manifest.json").read_text())
            self.assertEqual(saved["services"]["knowledge-retention"]["migrations"], {"minimum": MIDDLE, "maximum": LAST})


if __name__ == "__main__":
    unittest.main()
