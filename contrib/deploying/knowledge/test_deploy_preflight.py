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
        spec = plan()["services"][name] if name == "knowledge-web" else database_plan(name)["services"][name]
        services[name] = {key: copy.deepcopy(value) for key, value in spec.items() if key in fields}
        services[name]["service_account"] = f"{name}@example-project.iam.gserviceaccount.com"
        services[name]["secrets"] = {key: value.replace("projects/example/", "projects/example-project/") for key, value in services[name]["secrets"].items()}
        for variable in deploy.release.AUDIENCE_ENVIRONMENT.get(name, {}):
            services[name]["environment"].pop(variable, None)
    return {"schema_version": 1, "project": "example-project", "region": "us-east1",
            "source_repo_url": "https://github.com/example/carbon", "image_repository": "us-east1-docker.pkg.dev/example-project/knowledge",
            "pg_service": "knowledge-observer", "database_ca_secret": "projects/example-project/secrets/knowledge-source-database-ca/versions/3", "services": services}


class ProviderReads:
    def __init__(self, *, label=None, project_number="123456789"):
        self.calls = []
        self.shell = observed_web_shell()
        self.shell["spec"]["template"]["metadata"]["labels"] = {} if label is None else {"knowledge.carbon/revision-digest": label}
        self.project_number = project_number

    def call(self, args, *, capture=False):
        self.calls.append(args)
        if args[:3] == ["git", "ls-tree", "-r"]:
            root = Path(__file__).resolve().parents[3]
            return "\n".join(str(path.relative_to(root)) for path in (root / "packages/knowledge/migrations").glob("*.sql"))
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
            manifest = {"generation": 1, "services": {"knowledge-web": {"revision_digest": "reviewed"}}}
            (state / "release-manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "differs for knowledge-web"):
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
