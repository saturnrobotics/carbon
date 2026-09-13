"""Offline release-controller behavior. No provider calls are permitted."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("portal_release", HERE / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def plan(*, image="us-docker.pkg.dev/example/portal/web@sha256:" + "a" * 64):
    return {
        "schema_version": 1, "source_commit": "a" * 40, "expected_generation": 3, "generation": 4,
        "deploy": {"portal-web": ["source changed"]},
        "build_receipt": {"portal-web": {"image": image, "image_digest": image.rsplit("@", 1)[-1], "source_commit": "a" * 40}},
        "services": {"portal-web": {
            "kind": "service", "implementation_ready": True, "image": image,
            "service_account": "portal-web@example.iam.gserviceaccount.com",
            "environment": {
                "PORTAL_COMPANY_ID": "company-example",
                "PORTAL_MANUAL_SOURCE_JSON": '{"sourceId":"manuals","displayName":"Manual library"}',
                "PORTAL_RELEASE_PROFILE": "manual-v1",
                "PORTAL_QUERY_AUDIENCE": "query-audience",
                "PORTAL_QUERY_URL": "https://query.example",
                "PORTAL_WEB_IAP_AUDIENCE": "iap-audience",
                "PORTAL_WEB_ORIGIN": "https://portal.example",
                "PORTAL_WORKER_AUDIENCE": "worker-audience",
                "PORTAL_WORKER_URL": "https://worker.example",
            },
            "secrets": {},
            "resources": {"cpu": "1", "memory": "512Mi"}, "max_instances": 2,
            "concurrency": 20, "network": "portal-private",
            "subnetwork": "portal-runtime", "egress": "all-traffic",
        }},
    }


def observed_web_shell(*, iap="true"):
    """The portal-web Service as Terraform leaves it: IAP and ingress are service annotations."""
    annotations = {"run.googleapis.com/ingress": "all", "run.googleapis.com/operation-id": "synthetic"}
    if iap is not None:
        annotations["run.googleapis.com/iap-enabled"] = iap
    return {
        "metadata": {"name": "portal-web", "annotations": annotations},
        "spec": {"template": {"metadata": {"labels": {"portal.carbon/revision-digest": "old"}}}},
        "status": {"traffic": [{"revisionName": "portal-web-old", "percent": 100}]},
    }


def foundation_outputs(**overrides):
    audiences = {
        "portal-web": "/projects/123456789/locations/us-east1/services/portal-web",
        "portal-query": "https://portal-query-123456789.us-east1.run.app",
        "portal-ingest": "https://portal-ingest-123456789.us-east1.run.app",
        "portal-actions": "https://portal-actions-123456789.us-east1.run.app",
        **overrides,
    }
    return {"service_audiences": {"sensitive": False, "type": ["map", "string"], "value": audiences}}


class ReleaseControllerTests(unittest.TestCase):
    def test_audiences_come_from_the_foundation_outputs_and_drift_is_refused(self):
        candidate = plan()
        for variable in ("PORTAL_WEB_IAP_AUDIENCE", "PORTAL_QUERY_AUDIENCE", "PORTAL_WORKER_AUDIENCE"):
            candidate["services"]["portal-web"]["environment"].pop(variable)
        with self.assertRaisesRegex(ValueError, "missing mandatory runtime configuration: PORTAL_QUERY_AUDIENCE"):
            release.validate_plan(candidate)
        filled = release.apply_foundation_audiences(candidate, foundation_outputs())
        release.validate_plan(filled)
        environment = filled["services"]["portal-web"]["environment"]
        self.assertEqual(environment["PORTAL_WEB_IAP_AUDIENCE"], "/projects/123456789/locations/us-east1/services/portal-web")
        self.assertEqual(environment["PORTAL_QUERY_AUDIENCE"], "https://portal-query-123456789.us-east1.run.app")
        self.assertEqual(environment["PORTAL_WORKER_AUDIENCE"], "https://portal-ingest-123456789.us-east1.run.app")
        drifted = plan()
        with self.assertRaisesRegex(ValueError, "portal-web PORTAL_[A-Z_]+ differs from the foundation output .*--override-audiences"):
            release.apply_foundation_audiences(drifted, foundation_outputs())
        kept = release.apply_foundation_audiences(plan(), foundation_outputs(), override=True)
        self.assertEqual(kept["services"]["portal-web"]["environment"]["PORTAL_QUERY_AUDIENCE"], "query-audience")
        with self.assertRaisesRegex(ValueError, "lack an audience for: portal-ingest"):
            release.apply_foundation_audiences(plan(), {"service_audiences": {"value": {"portal-web": "w", "portal-query": "q"}}})
        with self.assertRaisesRegex(ValueError, "service_audiences"):
            release.apply_foundation_audiences(plan(), {"runtime_service_accounts": {"value": {}}})
        self.assertEqual(release.AUDIENCE_ENVIRONMENT["portal-ingest"], {"PORTAL_IDENTITY_AUDIENCE": "portal-query"})

    def test_web_replacement_keeps_the_foundation_owned_iap_annotation(self):
        rendered = release.revision_document("portal-web", plan()["services"]["portal-web"], "revision", observed_web_shell())
        self.assertEqual(rendered["metadata"]["annotations"], {"run.googleapis.com/iap-enabled": "true", "run.googleapis.com/ingress": "all"})
        for observed in (None, observed_web_shell(iap=None), observed_web_shell(iap="false")):
            with self.assertRaisesRegex(ValueError, "foundation shell with IAP enabled is not applied"):
                release.revision_document("portal-web", plan()["services"]["portal-web"], "revision", observed)
        query = dict(plan()["services"]["portal-web"], kind="service")
        self.assertNotIn("annotations", release.revision_document("portal-query", query, "revision", None)["metadata"])

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
        self.assertEqual(release.DATABASE_UNITS, {"portal-query", "portal-ingest", "portal-schema", "portal-retention"})
        query = dict(plan()["services"]["portal-web"], kind="service")
        interfaces = json.loads(release.revision_document("portal-query", query, "revision")["spec"]["template"]["metadata"]["annotations"]["run.googleapis.com/network-interfaces"])
        self.assertEqual(interfaces, [{"network": "portal-private", "subnetwork": "portal-runtime", "tags": "portal-source-database-client"}])
        job = dict(plan()["services"]["portal-web"], kind="job")
        interfaces = json.loads(release.revision_document("portal-parser", job, "revision")["spec"]["template"]["metadata"]["annotations"]["run.googleapis.com/network-interfaces"])
        self.assertEqual(interfaces, [{"network": "portal-private", "subnetwork": "portal-runtime"}])

    def test_retention_job_requires_its_narrow_runtime_configuration(self):
        self.assertEqual(release.UNITS["portal-retention"], "job")
        self.assertEqual(
            release.REQUIRED_ENVIRONMENT["portal-retention"],
            {"PORTAL_OBJECT_BUCKET"},
        )

    def test_database_ca_is_pinned_mounted_and_part_of_revision_identity(self):
        for name in sorted(release.DATABASE_UNITS):
            with self.subTest(name=name):
                candidate = database_plan(name)
                unit = candidate["services"][name]
                before = release.revision_digest(unit)
                unit["database_ca_secret"] = "projects/example/secrets/portal-source-database-ca/versions/3"
                release.validate_plan(candidate)
                self.assertNotEqual(release.revision_digest(unit), before)
                document = release.revision_document(name, unit, release.revision_digest(unit))
                template = document["spec"]["template"]
                runtime = template["spec"]["template"]["spec"] if unit["kind"] == "job" else template["spec"]
                self.assertEqual(runtime["volumes"], [{"name": "database-ca", "secret": {"secretName": "portal-source-database-ca", "items": [{"key": "3", "path": "ca.crt"}]}}])
                self.assertEqual(runtime["containers"][0]["volumeMounts"], [{"name": "database-ca", "mountPath": "/var/run/secrets/portal-source-database"}])
                previous = release.revision_digest(unit)
                unit["database_ca_secret"] = "projects/example/secrets/portal-source-database-ca/versions/4"
                self.assertNotEqual(release.revision_digest(unit), previous)
                unit["database_ca_secret"] = "projects/example/secrets/portal-source-database-ca/versions/latest"
                with self.assertRaisesRegex(ValueError, "pinned database CA"):
                    release.validate_plan(candidate)
        for name in ("portal-web", "portal-parser"):
            candidate = plan() if name == "portal-web" else database_plan(name)
            candidate["services"][name].pop("migrations", None)
            candidate["services"][name]["database_ca_secret"] = "projects/example/secrets/portal-source-database-ca/versions/3"
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "cannot receive a database CA"):
                release.validate_plan(candidate)

    def test_manual_release_rejects_deferred_units_and_configuration(self):
        self.assertNotIn("portal-actions", release.UNITS)
        candidate = plan()
        candidate["services"]["portal-web"]["environment"]["PORTAL_ACTIONS_URL"] = "https://actions.example"
        with self.assertRaisesRegex(ValueError, "deferred runtime configuration"):
            release.validate_plan(candidate)
        self.assertEqual(
            release.REQUIRED_SECRETS["portal-retention"],
            {"PORTAL_MAINTENANCE_DATABASE_URL"},
        )

    def test_live_source_registry_is_admitted_on_the_query_unit_alone(self):
        registry = json.dumps({"version": 1, "sources": [{"id": "carbon-source", "kind": "carbon", "origin": "https://erp.example", "audience": "erp-receiver-audience"}]})
        self.assertEqual(release.OPTIONAL_ENVIRONMENT["portal-query"], {"PORTAL_SOURCES_JSON"})
        # Optional, so the query unit is valid with it and valid without it.
        release.validate_plan(database_plan())
        admitted = database_plan()
        admitted["services"]["portal-query"]["environment"]["PORTAL_SOURCES_JSON"] = registry
        release.validate_plan(admitted)
        for unit in ("portal-web", "portal-ingest"):
            candidate = database_plan(unit) if unit in release.DATABASE_UNITS else plan()
            candidate["services"][unit]["environment"]["PORTAL_SOURCES_JSON"] = registry
            with self.assertRaisesRegex(ValueError, "deferred runtime configuration: PORTAL_SOURCES_JSON"):
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
            candidate["services"]["portal-query"]["environment"]["PORTAL_SOURCES_JSON"] = registry
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, "strict live-source registry"):
                release.validate_plan(candidate)
        for origin in ("http://erp.example", "https://user:secret@erp.example", "https://erp.example/portal", "https://erp.example/?source=carbon", "not a url"):
            candidate = database_plan()
            candidate["services"]["portal-query"]["environment"]["PORTAL_SOURCES_JSON"] = json.dumps({"version": 1, "sources": [dict(source, origin=origin)]})
            with self.subTest(origin=origin), self.assertRaisesRegex(ValueError, "bare https URL without credentials"):
                release.validate_plan(candidate)
        duplicated = database_plan()
        duplicated["services"]["portal-query"]["environment"]["PORTAL_SOURCES_JSON"] = json.dumps({"version": 1, "sources": [source, dict(source, origin="https://other.example")]})
        with self.assertRaisesRegex(ValueError, "two sources under one ID"):
            release.validate_plan(duplicated)

    def test_rejects_a_source_kind_this_release_does_not_ship(self):
        self.assertEqual(release.SOURCE_REGISTRY_KINDS, {"carbon"})
        for kind in ("kanban", "engineering", "crm", "sharepoint"):
            candidate = database_plan()
            candidate["services"]["portal-query"]["environment"]["PORTAL_SOURCES_JSON"] = json.dumps({"version": 1, "sources": [{"id": "source", "kind": kind, "origin": "https://source.example", "audience": "audience"}]})
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, f"does not ship: {kind}"):
                release.validate_plan(candidate)

    def test_noop_issues_no_mutations(self):
        self.assertEqual(release.select_mutations({**plan(), "deploy": {}}, {"generation": 3, "services": {}}, {}), [])

    def test_rejects_mutable_image_and_secret_versions(self):
        with self.assertRaisesRegex(ValueError, "immutable image digest"):
            release.validate_plan(plan(image="us-docker.pkg.dev/example/portal/web:latest"))
        candidate = plan()
        candidate["services"]["portal-web"]["secrets"] = {
            "UNEXPECTED": "projects/example/secrets/portal-db-url/versions/latest"
        }
        with self.assertRaisesRegex(ValueError, "pinned secret version"):
            release.validate_plan(candidate)

    def test_rejects_browser_or_parser_secrets_and_missing_direct_vpc_egress(self):
        candidate = plan()
        candidate["services"]["portal-web"]["secrets"] = {
            "UNEXPECTED": "projects/example/secrets/portal-db-url/versions/7"
        }
        with self.assertRaisesRegex(ValueError, "must not receive runtime secrets"):
            release.validate_plan(candidate)
        candidate = plan()
        candidate["services"]["portal-web"].pop("network")
        with self.assertRaisesRegex(ValueError, "Direct VPC egress"):
            release.validate_plan(candidate)

    def test_rejects_a_selected_image_without_its_verified_build_receipt(self):
        candidate = plan()
        candidate["build_receipt"] = {}
        with self.assertRaisesRegex(ValueError, "verified build receipt"):
            release.validate_plan(candidate)

    def test_rejects_unimplemented_service_and_manual_revision_drift(self):
        unready = plan()
        unready["services"]["portal-web"]["implementation_ready"] = False
        with self.assertRaisesRegex(ValueError, "not implementation-ready"):
            release.validate_plan(unready)
        expected = {"generation": 3, "services": {"portal-web": {"revision_digest": "expected"}}}
        with self.assertRaisesRegex(ValueError, "configuration drift"):
            release.select_mutations(plan(), expected, {"portal-web": "hand-edited"})

    def test_selects_only_affected_service_and_stages_before_promotion(self):
        expected = {"generation": 3, "services": {"portal-web": {"revision_digest": "old"}, "portal-query": {"revision_digest": "query"}}}
        changes = release.select_mutations(plan(), expected, {"portal-web": "old", "portal-query": "query"})
        self.assertEqual([change["name"] for change in changes], ["portal-web"])
        self.assertEqual(changes[0]["strategy"], "stage-then-promote")

    def test_renders_direct_vpc_egress_in_the_revision_spec(self):
        rendered = release.revision_document("portal-web", plan()["services"]["portal-web"], "revision", observed_web_shell())
        annotations = rendered["spec"]["template"]["metadata"]["annotations"]
        self.assertEqual(annotations["run.googleapis.com/vpc-access-egress"], "all-traffic")
        self.assertEqual(
            json.loads(annotations["run.googleapis.com/network-interfaces"]),
            [{"network": "portal-private", "subnetwork": "portal-runtime"}],
        )

    def test_promotes_exact_startup_checked_revision_without_runtime_impersonation(self):
        adapter = CloudProtocol()
        current = {"generation": 3, "services": {"portal-web": {"revision_digest": "old"}}}
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            release.promote(plan(), current, project="example", region="us-east1", manifest=manifest, adapter=adapter)
            staged = adapter.documents["portal-web"]
            self.assertIn("name", staged["spec"]["template"]["metadata"], "Stage an explicitly named revision")
            revision = staged["spec"]["template"]["metadata"]["name"]
            probe = staged["spec"]["template"]["spec"]["containers"][0]["startupProbe"]
            self.assertEqual(probe["httpGet"], {"path": "/health", "port": 8080})
            self.assertLessEqual(probe["failureThreshold"] * probe["periodSeconds"], 240)
            self.assertEqual(staged["spec"]["traffic"], [{"revisionName": "portal-web-old", "percent": 100}])
            self.assertFalse(any("--no-traffic" in call or "--file" in call for call in adapter.calls))
            self.assertTrue(any(f"--to-revisions={revision}=100" in call for call in adapter.calls))
            self.assertFalse(any("--to-latest" in call or call[0] == "curl" or "print-identity-token" in call for call in adapter.calls))
            saved = json.loads(manifest.read_text())
            self.assertEqual(saved["generation"], 4)
            self.assertEqual(saved["services"]["portal-web"]["deployed_revision"], revision)

    def test_old_ready_revision_cannot_pass_the_staged_health_gate(self):
        for failure in ("not-ready", "old-ready", "newer-created"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                adapter = CloudProtocol(failure=failure)
                manifest = Path(directory) / "manifest.json"
                with self.assertRaisesRegex(ValueError, "staged revision"):
                    release.promote(plan(), {"generation": 3, "services": {"portal-web": {"revision_digest": "old"}}}, project="example", region="us-east1", manifest=manifest, adapter=adapter)
                self.assertFalse(manifest.exists())
                if failure == "newer-created":
                    self.assertEqual(len([call for call in adapter.calls if "replace" in call]), 1, "Never restore over a concurrent writer")
                traffic_calls = [call for call in adapter.calls if "update-traffic" in call]
                self.assertTrue(all("--to-revisions=portal-web-old=100" in call for call in traffic_calls))

    def test_failed_stage_restores_prior_template_so_the_same_plan_can_retry(self):
        adapter = CloudProtocol(failure="not-ready")
        current = {"generation": 3, "services": {"portal-web": {"revision_digest": "old"}}}
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            with self.assertRaisesRegex(ValueError, "staged revision"):
                release.promote(plan(), current, project="example", region="us-east1", manifest=manifest, adapter=adapter)
            restored = adapter.documents["portal-web"]
            self.assertEqual(restored["spec"]["template"], observed_web_shell()["spec"]["template"])
            adapter.failure = None
            release.promote(plan(), current, project="example", region="us-east1", manifest=manifest, adapter=adapter)
            self.assertTrue(manifest.exists())

    def test_existing_unrecorded_runtime_cannot_be_silently_adopted(self):
        for labeled in (True, False):
            adapter = CloudProtocol()
            candidate = database_plan()
            existing = release.revision_document("portal-query", candidate["services"]["portal-query"], release.revision_digest(candidate["services"]["portal-query"]))
            if not labeled:
                existing["spec"]["template"]["metadata"].pop("labels")
            adapter.documents["portal-query"] = existing
            with self.subTest(labeled=labeled), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(ValueError, "unrecorded"):
                    release.promote(candidate, {"generation": 3, "services": {}}, project="example", region="us-east1", manifest=Path(directory) / "manifest.json", adapter=adapter, ledger=ledger(LAST))
                self.assertFalse(any("replace" in call for call in adapter.calls))

    def test_job_documents_follow_cloud_run_v1_schema_and_have_valid_digest_labels(self):
        candidate = database_plan("portal-schema")
        unit = candidate["services"]["portal-schema"]
        digest = release.revision_digest(unit)
        document = release.revision_document("portal-schema", unit, digest)
        self.assertIn("spec", document["spec"]["template"], "Cloud Run jobs require ExecutionTemplateSpec.spec")
        execution = document["spec"]["template"]["spec"]
        self.assertEqual(execution["taskCount"], 1)
        self.assertEqual(execution["parallelism"], 1)
        template = execution["template"]
        self.assertNotIn("containerConcurrency", template["spec"])
        self.assertEqual(template["spec"]["maxRetries"], 0)
        self.assertIn("timeoutSeconds", template["spec"])
        self.assertNotIn("metadata", template, "Network and digest belong to the execution template")
        metadata = document["spec"]["template"]["metadata"]
        self.assertIn("run.googleapis.com/network-interfaces", metadata["annotations"])
        for value in metadata["labels"].values():
            self.assertLessEqual(len(value), 63)
            self.assertRegex(value, r"^[a-z0-9_-]+$")
        self.assertEqual(release.observed_digest("portal-schema", document), digest)

    def test_repeated_job_promotion_uses_jobs_api_and_correct_nested_digest(self):
        candidate = database_plan("portal-schema")
        adapter = CloudProtocol()
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            release.promote(candidate, {"generation": 3, "services": {}}, project="example", region="us-east1", manifest=manifest, adapter=adapter, ledger=ledger())
            current = json.loads(manifest.read_text())
            candidate.update(expected_generation=4, generation=5)
            release.promote(candidate, current, project="example", region="us-east1", manifest=manifest, adapter=adapter, ledger=ledger())
            with patch.object(release, "run", adapter.call):
                observed = release.observed_revision_digests("example", "us-east1", ["portal-schema"])
            self.assertEqual(observed["portal-schema"], current["services"]["portal-schema"]["revision_digest"])
            self.assertFalse(any(call[2] == "services" for call in adapter.calls))

    def test_completed_units_are_recorded_if_later_unit_fails(self):
        candidate = database_plan("portal-retention")
        web = plan()
        for field in ("services", "deploy", "build_receipt"):
            candidate[field].update(web[field])
        adapter = CloudProtocol(failure="not-ready")
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            with self.assertRaisesRegex(ValueError, "staged revision"):
                release.promote(candidate, {"generation": 3, "services": {"portal-web": {"revision_digest": "old"}}}, project="example", region="us-east1", manifest=manifest, adapter=adapter, ledger=ledger(LAST))
            self.assertTrue(manifest.exists(), "Completed units must be persisted before a later unit fails")
            saved = json.loads(manifest.read_text())
            self.assertIn("portal-retention", saved["services"])
            self.assertEqual(saved["services"]["portal-web"]["revision_digest"], "old")
            self.assertEqual(saved["generation"], 4)


class CloudProtocol:
    """Emulates cloud resource state, including separate staged/serving revisions."""
    def __init__(self, *, failure=None):
        self.calls = []
        self.documents = {}
        self.failure = failure

    def call(self, args, *, capture=False):
        self.calls.append(args)
        if "print-identity-token" in args:
            return "synthetic-token"
        if "replace" in args:
            document = json.loads(Path(args[4]).read_text())
            name = document["metadata"]["name"]
            self.documents[name] = document
            return ""
        if "describe" in args:
            name = args[4]
            if name not in self.documents:
                if name == "portal-web":
                    return json.dumps(observed_web_shell())
                raise release.subprocess.CalledProcessError(1, args)
            document = json.loads(json.dumps(self.documents[name]))
            if args[2] == "jobs":
                document["metadata"]["generation"] = 9
                return json.dumps(document)
            revision = document["spec"]["template"]["metadata"].get("name", "missing-name")
            document["status"] = {
                "url": "https://portal-web.example",
                "latestReadyRevisionName": "portal-web-old" if self.failure == "old-ready" else revision,
                "latestCreatedRevisionName": "portal-web-concurrent" if self.failure == "newer-created" else revision,
                "conditions": [{"type": "Ready", "status": "False" if self.failure == "not-ready" else "True"}],
                "traffic": [{"revisionName": "portal-web-old", "percent": 100}],
            }
            return json.dumps(document)
        return ""


FIRST, MIDDLE, LAST = "20260908000245_knowledge-foundation", "20260908014537_retention-recovery", "20260908050421_ingest-source-visibility-execute"


def database_plan(unit="portal-query", *, minimum=FIRST, maximum=LAST):
    """A plan selecting one database unit with a declared compatible migration window."""
    image = f"us-docker.pkg.dev/example/portal/{unit}@sha256:" + "b" * 64
    candidate = plan()
    spec = dict(candidate["services"].pop("portal-web"), kind=release.UNITS[unit], image=image)
    spec["service_account"] = f"{unit}@example.iam.gserviceaccount.com"
    spec["environment"] = {key: "value" for key in release.REQUIRED_ENVIRONMENT[unit]}
    if "PORTAL_MANUAL_SOURCE_JSON" in spec["environment"]:
        spec["environment"]["PORTAL_MANUAL_SOURCE_JSON"] = '{"sourceId":"manuals","displayName":"Manual library"}'
    if "PORTAL_RELEASE_PROFILE" in spec["environment"]:
        spec["environment"]["PORTAL_RELEASE_PROFILE"] = "manual-v1"
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
                candidate["services"]["portal-query"]["migrations"] = window
                with self.assertRaisesRegex(ValueError, "requires migrations.minimum and migrations.maximum"):
                    release.validate_plan(candidate)
        with self.assertRaisesRegex(ValueError, "minimum is newer than migrations.maximum"):
            release.validate_plan(database_plan(minimum=LAST, maximum=FIRST))
        web = plan()
        web["services"]["portal-web"]["migrations"] = {"minimum": FIRST, "maximum": LAST}
        with self.assertRaisesRegex(ValueError, "portal-web holds no database credential"):
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
        self.assertEqual(release.check_migration_compatibility(inside, ledger(FIRST, MIDDLE)), {"portal-query": MIDDLE})
        self.assertEqual([m["name"] for m in release.select_mutations(inside, current, {}, ledger(FIRST, MIDDLE))], ["portal-query"])
        with self.assertRaisesRegex(ValueError, "requires --schema-ledger"):
            release.select_mutations(inside, current, {})
        with self.assertRaisesRegex(ValueError, f"requires migration {MIDDLE} but the ledger head is {FIRST}; run the schema job first"):
            release.select_mutations(database_plan(minimum=MIDDLE, maximum=LAST), current, {}, ledger(FIRST))
        with self.assertRaisesRegex(ValueError, f"supports migrations up to {MIDDLE} but the ledger head is {LAST}"):
            release.select_mutations(inside, current, {}, ledger(FIRST, MIDDLE, LAST))
        with self.assertRaisesRegex(ValueError, "cannot be promoted before the schema job applies the first"):
            release.select_mutations(inside, current, {}, ledger())
        self.assertEqual(release.check_migration_compatibility(database_plan("portal-schema"), ledger()), {"portal-schema": None})
        with self.assertRaisesRegex(ValueError, "portal-schema supports migrations up to"):
            release.check_migration_compatibility(database_plan("portal-schema", minimum=FIRST, maximum=MIDDLE), ledger(LAST))
        self.assertEqual(release.check_migration_compatibility(plan(), None), {})

    def test_promote_checks_the_ledger_before_any_write_and_records_the_window(self):
        class RecordingGcloud:
            def __init__(self): self.calls = []; self.exists = False
            def call(self, args, *, capture=False):
                self.calls.append(args)
                if "replace" in args:
                    self.exists = True
                if "describe" in args:
                    if not self.exists:
                        raise release.subprocess.CalledProcessError(1, args)
                    return json.dumps({"metadata": {"generation": 9}})
                return ""
        candidate = database_plan("portal-retention", minimum=MIDDLE, maximum=LAST)
        with tempfile.TemporaryDirectory() as directory:
            adapter = RecordingGcloud()
            with self.assertRaisesRegex(ValueError, "run the schema job first"):
                release.promote(candidate, {"generation": 3, "services": {}}, project="example", region="us-east1", manifest=Path(directory) / "manifest.json", adapter=adapter, ledger=ledger(FIRST))
            self.assertFalse(any("replace" in call for call in adapter.calls))
            self.assertFalse((Path(directory) / "manifest.json").exists())
            release.promote(candidate, {"generation": 3, "services": {}}, project="example", region="us-east1", manifest=Path(directory) / "manifest.json", adapter=adapter, ledger=ledger(FIRST, MIDDLE))
            saved = json.loads((Path(directory) / "manifest.json").read_text())
            self.assertEqual(saved["services"]["portal-retention"]["migrations"], {"minimum": MIDDLE, "maximum": LAST})


if __name__ == "__main__":
    unittest.main()
