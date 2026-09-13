"""Independent orchestration boundary checks with synthetic provider responses."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_deploy import module
from test_release import database_plan, foundation_outputs, observed_web_shell, plan


def configuration(deploy):
    fields = {"service_account", "environment", "secrets", "resources", "max_instances", "concurrency", "network", "subnetwork", "egress"}
    services = {}
    for name in deploy.ORDER:
        spec = plan()["services"][name] if name == "portal-web" else database_plan(name)["services"][name]
        services[name] = {key: copy.deepcopy(value) for key, value in spec.items() if key in fields}
        services[name]["service_account"] = f"{name}@example-project.iam.gserviceaccount.com"
        services[name]["secrets"] = {key: value.replace("projects/example/", "projects/example-project/") for key, value in services[name]["secrets"].items()}
        for variable in deploy.release.AUDIENCE_ENVIRONMENT.get(name, {}):
            services[name]["environment"].pop(variable, None)
    return {"schema_version": 1, "project": "example-project", "region": "us-east1",
            "source_repo_url": "https://github.com/example/carbon", "image_repository": "us-east1-docker.pkg.dev/example-project/portal",
            "pg_service": "portal-observer", "database_ca_secret": "projects/example-project/secrets/portal-source-database-ca/versions/3", "services": services}


class ProviderReads:
    def __init__(self, *, label=None, project_number="123456789"):
        self.calls = []
        self.shell = observed_web_shell()
        self.shell["spec"]["template"]["metadata"]["labels"] = {} if label is None else {"portal.carbon/revision-digest": label}
        self.project_number = project_number

    def call(self, args, *, capture=False):
        self.calls.append(args)
        if args[:3] == ["git", "ls-tree", "-r"]:
            root = Path(__file__).resolve().parents[3]
            return "\n".join(str(path.relative_to(root)) for path in (root / "packages/portal/migrations").glob("*.sql"))
        if args[0] == "terraform":
            return json.dumps(foundation_outputs())
        if args[:3] == ["gcloud", "projects", "describe"]:
            return self.project_number
        if args[:4] == ["gcloud", "run", "services", "list"]:
            return json.dumps([self.shell])
        if args[:4] == ["gcloud", "run", "jobs", "list"]:
            return "[]"
        if args[0] == "psql" and "SELECT to_regclass" in args[-1]:
            return "f"
        if args[0] == "psql" and "SELECT to_regprocedure" in args[-1]:
            return "t"
        if args[0] == "docker" and args[1:] in (["info"], ["buildx", "version"]):
            return "synthetic available"
        if args[-1].endswith(("verify-build-context.py", "verify-license-boundary.py")):
            return "synthetic passed"
        raise AssertionError(f"Unexpected command family: {args[:3]}")


class DeploymentPreflightTests(unittest.TestCase):
    def setUp(self):
        self.deploy = module()
        self.config = configuration(self.deploy)
        self.deploy.validate_config(self.config)

    def test_check_observes_foundation_and_ledger_without_building_or_promoting(self):
        adapter = ProviderReads()
        with tempfile.TemporaryDirectory() as directory, patch.object(self.deploy, "source_revision", return_value="a" * 40):
            state = Path(directory)
            self.deploy.orchestrate(self.config, state, apply=False, adapter=adapter)
            self.assertEqual(list(state.iterdir()), [])
        self.assertTrue(any(args[0] == "psql" for args in adapter.calls))
        self.assertTrue(any(args[:4] == ["gcloud", "run", "jobs", "list"] for args in adapter.calls))
        self.assertFalse(any("--push" in args or "replace" in args or "execute" in args or "update-traffic" in args for args in adapter.calls))

    def test_failed_source_verification_never_reaches_cloud_or_build_commands(self):
        adapter = ProviderReads()
        with tempfile.TemporaryDirectory() as directory, patch.object(self.deploy, "source_revision", side_effect=ValueError("synthetic failed source check")):
            with self.assertRaisesRegex(ValueError, "source check"):
                self.deploy.orchestrate(self.config, Path(directory), apply=True, adapter=adapter)
        self.assertEqual(adapter.calls, [])

    def test_existing_drift_stops_before_local_builds_or_cloud_mutations(self):
        adapter = ProviderReads(label="manual-edit")
        with tempfile.TemporaryDirectory() as directory, patch.object(self.deploy, "source_revision", return_value="a" * 40):
            state = Path(directory)
            manifest = {"generation": 1, "services": {"portal-web": {"revision_digest": "reviewed"}}}
            (state / "release-manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "differs for portal-web"):
                self.deploy.orchestrate(self.config, state, apply=True, adapter=adapter)
            self.assertEqual(json.loads((state / "release-manifest.json").read_text()), manifest)
            self.assertEqual([file.name for file in state.iterdir()], ["release-manifest.json"])
        self.assertFalse(any(args[0] == "docker" or "replace" in args or "execute" in args for args in adapter.calls))

    def test_wrong_foundation_target_stops_before_builds_or_runtime_reads(self):
        adapter = ProviderReads(project_number="999999999")
        with tempfile.TemporaryDirectory() as directory, patch.object(self.deploy, "source_revision", return_value="a" * 40):
            with self.assertRaisesRegex(ValueError, "foundation does not match"):
                self.deploy.orchestrate(self.config, Path(directory), apply=True, adapter=adapter)
        self.assertFalse(any(args[0] in {"docker", "psql"} or args[:2] == ["gcloud", "run"] for args in adapter.calls))

    def test_missing_carbon_public_migration_stops_before_image_builds(self):
        class OldDatabase(ProviderReads):
            def call(self, args, *, capture=False):
                result = super().call(args, capture=capture)
                return "f" if args[0] == "psql" and "SELECT to_regprocedure" in args[-1] else result

        adapter = OldDatabase()
        with tempfile.TemporaryDirectory() as directory, patch.object(self.deploy, "source_revision", return_value="a" * 40):
            with self.assertRaisesRegex(ValueError, "Apply the Carbon Portal public-identifiers migration"):
                self.deploy.orchestrate(self.config, Path(directory), apply=False, adapter=adapter)
        self.assertFalse(any(args[0] == "docker" or "--push" in args or "replace" in args for args in adapter.calls))

    def test_legacy_cloud_workloads_are_not_silently_mixed_with_portal(self):
        class MixedProvider(ProviderReads):
            def call(self, args, *, capture=False):
                result = super().call(args, capture=capture)
                if args[:4] == ["gcloud", "run", "services", "list"]:
                    return json.dumps([self.shell, {"metadata": {"name": "knowledge-query"}}])
                return result

        adapter = MixedProvider()
        with tempfile.TemporaryDirectory() as directory, patch.object(self.deploy, "source_revision", return_value="a" * 40):
            with self.assertRaisesRegex(ValueError, "Legacy platform workloads"):
                self.deploy.orchestrate(self.config, Path(directory), apply=True, adapter=adapter)
        self.assertFalse(any("--push" in args or "replace" in args or "execute" in args for args in adapter.calls))

    def test_default_setup_detects_existing_private_legacy_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "knowledge/.local/deploy.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text('{"sensitive": "synthetic-private-value"}')
            with patch.object(self.deploy, "HERE", root / "portal"):
                with self.assertRaisesRegex(ValueError, "Existing legacy deployment configuration") as failure:
                    self.deploy.read_config(root / "portal/.local/deploy.json")
            self.assertNotIn("synthetic-private-value", str(failure.exception))
            self.assertEqual(json.loads(legacy.read_text()), {"sensitive": "synthetic-private-value"})

    def test_reusing_state_for_another_target_stops_before_provider_calls(self):
        adapter = ProviderReads()
        with tempfile.TemporaryDirectory() as directory, patch.object(self.deploy, "source_revision", return_value="a" * 40):
            state = Path(directory)
            (state / "target.json").write_text(json.dumps({"project": "other-project"}))
            with self.assertRaisesRegex(ValueError, "another target"):
                self.deploy.orchestrate(self.config, state, apply=True, adapter=adapter)
        self.assertEqual(adapter.calls, [])


if __name__ == "__main__":
    unittest.main()


class LedgerRenameTests(unittest.TestCase):
    def observe(self, present):
        class LedgerReader:
            def __init__(self):
                self.calls = []

            def call(self, args, *, capture=False):
                self.calls.append(args)
                sql = args[-1]
                if sql.startswith("SELECT to_regclass"):
                    schema = sql.split("'")[1].split(".")[0]
                    return "t" if schema in present else "f"
                if "FROM " in sql:
                    schema = sql.rsplit("FROM ", 1)[1].split(".")[0]
                    if schema not in present:
                        raise AssertionError("Read a missing ledger")
                    return json.dumps({"schema_version": 1, "names": ["20260908000245_knowledge-foundation"]})
                raise AssertionError("Unexpected ledger query")

        reader = LedgerReader()
        result = module().live_ledger({"pg_service": "synthetic-observer"}, reader)
        return result, reader.calls

    def test_existing_database_is_observed_before_portal_schema_rename(self):
        observation, calls = self.observe({"knowledge_migrations"})
        self.assertEqual(observation["names"], ["20260908000245_knowledge-foundation"])
        self.assertTrue(any("FROM knowledge_migrations.ledger" in args[-1] for args in calls))

    def test_portal_database_is_observed_after_schema_rename(self):
        observation, calls = self.observe({"portal_migrations"})
        self.assertEqual(len(observation["names"]), 1)
        self.assertTrue(any("FROM portal_migrations.ledger" in args[-1] for args in calls))

    def test_two_ledgers_are_ambiguous_and_refused(self):
        with self.assertRaisesRegex(ValueError, "Both legacy and Portal migration ledgers"):
            self.observe({"portal_migrations", "knowledge_migrations"})

    def test_absent_ledgers_are_a_fresh_database(self):
        observation, calls = self.observe(set())
        self.assertEqual(observation, {"schema_version": 1, "names": []})
        self.assertFalse(any("FROM " in args[-1] for args in calls))
