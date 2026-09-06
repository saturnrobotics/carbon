"""Offline provisioning boundary tests. No cloud requests or mutations."""

import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("carbon_backup_setup", HERE / "setup.py")
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


def configuration():
    return setup.configuration(
        {"PROJECT_ID": "example-project", "REGION": "us-east1", "ZONE": "us-east1-b", "VM_NAME": "carbon"},
        {"source_buckets": ["example-external-attachments"]},
    )


class SimulatedProvisioner(setup.Provisioner):
    """Record the real provisioner's requests against an empty fake project."""

    def __init__(self, config, private_dir):
        super().__init__(config, private_dir)
        self.calls = []
        self.requests = []
        self.buckets = {
            "example-external-attachments": {
                "name": "example-external-attachments", "projectNumber": "222",
                "versioning": {"enabled": True},
            }
        }
        self.build_sources = []
        self.build_definition = None
        self.environment = None

    def command(self, *args, json_output=False):
        self.calls.append(args)
        if args[:2] == ("builds", "submit"):
            source = Path(args[2])
            self.build_sources = sorted(p.name for p in source.iterdir())
            self.build_definition = json.loads(Path(args[args.index("--config") + 1]).read_text())
        if args[:3] == ("run", "jobs", "deploy"):
            self.environment = json.loads(Path(args[args.index("--env-vars-file") + 1]).read_text())
        return [] if json_output else ""

    def api(self, url, method="GET", data=None, missing=False):
        self.requests.append((url, method, copy.deepcopy(data)))
        if "cloudresourcemanager.googleapis.com" in url:
            return {"projectNumber": "111"}
        if url.startswith("https://storage.googleapis.com/storage/v1/b?"):
            bucket = {**data, "projectNumber": "111"}
            self.buckets[data["name"]] = bucket
            return bucket
        if url.startswith("https://storage.googleapis.com/storage/v1/b/"):
            name = url.rsplit("/", 1)[-1]
            if method == "PATCH":
                self.buckets[name].update(data)
            return copy.deepcopy(self.buckets.get(name))
        if url.endswith("/notificationChannels"):
            return {"name": "projects/example-project/notificationChannels/1"} if method == "POST" else {}
        if url.endswith("/alertPolicies"):
            return {"name": "projects/example-project/alertPolicies/1"} if method == "POST" else {}
        if missing:
            return None
        return {}


class ProvisioningBoundaries(unittest.TestCase):
    def provision(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        provisioner = SimulatedProvisioner(configuration(), Path(directory.name))
        with contextlib.redirect_stdout(io.StringIO()):
            provisioner.provision()
        return provisioner

    def test_source_permissions_remain_read_only_and_bound_to_each_bucket(self):
        provisioner = self.provision()
        source_bindings = [call for call in provisioner.calls
                           if call[:3] == ("storage", "buckets", "add-iam-policy-binding")
                           and call[3] == "gs://example-external-attachments"]
        self.assertEqual({call[call.index("--role") + 1] for call in source_bindings},
                         {"roles/storage.legacyBucketReader", "roles/storage.objectViewer"})
        self.assertTrue(all("-backup-worker@" in call[call.index("--member") + 1] for call in source_bindings))
        self.assertFalse(any(method != "GET" and url.endswith("/example-external-attachments")
                             for url, method, _ in provisioner.requests))
        project_bindings = [call for call in provisioner.calls if call[:2] == ("projects", "add-iam-policy-binding")]
        self.assertFalse(any("roles/storage.admin" in call or "roles/compute.admin" in call for call in project_bindings))

    def test_snapshot_delete_permission_is_restricted_to_managed_snapshot_names(self):
        provisioner = self.provision()
        roles = [data["role"] for url, method, data in provisioner.requests
                 if method == "POST" and url.endswith("/roles")]
        delete_roles = [role for role in roles if "compute.snapshots.delete" in role["includedPermissions"]]
        self.assertEqual(len(delete_roles), 1)
        self.assertEqual(set(delete_roles[0]["includedPermissions"]), {
            "compute.snapshots.get", "compute.snapshots.delete", "compute.snapshots.setLabels"
        })
        grants = [call for call in provisioner.calls if call[:2] == ("projects", "add-iam-policy-binding")
                  and any(value.endswith("_backup_snapshots") for value in call)]
        self.assertEqual(len(grants), 1)
        self.assertIn("--condition", grants[0])
        self.assertIn("projects/example-project/global/snapshots/carbon-cold-", grants[0][grants[0].index("--condition") + 1])

    def test_build_context_excludes_private_runtime_configuration(self):
        provisioner = self.provision()
        self.assertEqual(provisioner.build_sources, ["Dockerfile", "build.json", "runner.py"])
        self.assertNotIn("example-external-attachments", json.dumps(provisioner.build_definition))
        self.assertIn("-backup-build@", provisioner.build_definition["serviceAccount"])
        self.assertEqual(provisioner.build_definition["options"]["logging"], "CLOUD_LOGGING_ONLY")
        runtime = json.loads(provisioner.environment["BACKUP_CONFIG"])
        self.assertEqual(runtime["source_buckets"], ["example-external-attachments"])

    def test_existing_content_tag_reuses_image_without_uploading_a_build(self):
        with tempfile.TemporaryDirectory() as directory:
            provisioner = SimulatedProvisioner(configuration(), Path(directory))
            original = provisioner.api

            def existing_tag(url, method="GET", data=None, missing=False):
                if "/packages/runner/tags/" in url:
                    return {"name": url.removeprefix("https://artifactregistry.googleapis.com/v1/")}
                return original(url, method, data, missing)

            with patch.object(provisioner, "api", side_effect=existing_tag), contextlib.redirect_stdout(io.StringIO()):
                provisioner.provision()
            self.assertFalse(any(call[:2] == ("builds", "submit") for call in provisioner.calls))
            self.assertTrue(any(call[:3] == ("run", "jobs", "deploy") for call in provisioner.calls))

    def test_unversioned_source_cannot_reach_scheduling(self):
        with tempfile.TemporaryDirectory() as directory:
            provisioner = SimulatedProvisioner(configuration(), Path(directory))
            provisioner.buckets["example-external-attachments"]["versioning"]["enabled"] = False
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, "versioning"):
                provisioner.provision()
            self.assertFalse(any(call[:2] == ("scheduler", "jobs") and call[2] in ("create", "update", "resume") for call in provisioner.calls))
            self.assertFalse(any(call[:3] == ("run", "jobs", "deploy") for call in provisioner.calls))

    def test_bucket_adoption_fails_before_patch_for_wrong_owner_label_or_location(self):
        for overrides in ({"projectNumber": "999"}, {"labels": {}}, {"location": "EU"}):
            with self.subTest(overrides=overrides), tempfile.TemporaryDirectory() as directory:
                provisioner = SimulatedProvisioner(configuration(), Path(directory))
                bucket = provisioner.c["bucket"]
                provisioner.buckets[bucket] = {
                    "name": bucket, "location": provisioner.c["location"], "projectNumber": "111",
                    "labels": {"managed-by": "carbon-cold-backup"}, **overrides,
                }
                with self.assertRaises(ValueError):
                    provisioner.bucket(bucket, "ARCHIVE")
                self.assertFalse(any(method != "GET" for _, method, _ in provisioner.requests))

    def test_custom_metric_absence_and_retest_total_thirty_hours(self):
        provisioner = self.provision()
        policies = [data for url, method, data in provisioner.requests if url.endswith("/alertPolicies") and method == "POST"]
        overdue = next(policy for policy in policies if policy["displayName"].endswith("overdue"))
        condition = overdue["conditions"][0]["conditionPrometheusQueryLanguage"]
        lookback = re.search(r"\[(\d+)h\]", condition["query"])
        self.assertIsNotNone(lookback)
        lookback_seconds = int(lookback.group(1)) * 3600
        retest_seconds = int(condition["duration"].removesuffix("s"))
        self.assertLessEqual(lookback_seconds, 25 * 3600)
        self.assertEqual(lookback_seconds + retest_seconds, 30 * 3600)
        self.assertGreaterEqual(int(condition["evaluationInterval"].removesuffix("s")), 30)

    def test_metric_descriptor_get_preserves_metric_type_path_separators(self):
        provisioner = self.provision()
        descriptor_gets = [url for url, method, _ in provisioner.requests
                           if method == "GET" and "/metricDescriptors/" in url]
        self.assertEqual(descriptor_gets, [
            "https://monitoring.googleapis.com/v3/projects/example-project/metricDescriptors/"
            "custom.googleapis.com/carbon_backup/last_success"
        ])

    def test_scheduler_uses_oauth_and_a_distinct_job_only_invoker(self):
        provisioner = self.provision()
        schedule = next(call for call in provisioner.calls if call[:3] == ("scheduler", "jobs", "create"))
        self.assertIn("--oauth-service-account-email", schedule)
        self.assertIn("--schedule=0 5 * * *", schedule)
        self.assertNotIn("--oidc-service-account-email", schedule)
        invoker = next(call for call in provisioner.calls if call[:3] == ("run", "jobs", "add-iam-policy-binding"))
        self.assertIn("--role=roles/run.invoker", invoker)
        self.assertIn("-backup-schedule@", invoker[invoker.index("--member") + 1])


class PrivateFailureReporting(unittest.TestCase):
    def test_command_failure_keeps_provider_output_in_private_log(self):
        with tempfile.TemporaryDirectory() as directory:
            provisioner = setup.Provisioner(configuration(), Path(directory))
            response = subprocess.CompletedProcess([], 1, "synthetic-sensitive-resource", "synthetic-sensitive-detail")
            with patch.object(setup.subprocess, "run", return_value=response), self.assertRaises(ValueError) as error:
                provisioner.command("run", "jobs", "list")
            self.assertNotIn("synthetic-sensitive", str(error.exception))
            self.assertIn("synthetic-sensitive-detail", provisioner.log.read_text())
            self.assertEqual(provisioner.log.stat().st_mode & 0o777, 0o600)

    def test_api_failure_keeps_response_body_out_of_public_error(self):
        with tempfile.TemporaryDirectory() as directory:
            provisioner = setup.Provisioner(configuration(), Path(directory))
            provisioner.token = "synthetic-token"
            provisioner.token_time = setup.time.monotonic()
            failure = urllib.error.HTTPError("https://storage.googleapis.com/test", 403, "Forbidden", {}, io.BytesIO(b"synthetic-sensitive-detail"))
            with patch.object(setup.urllib.request, "urlopen", side_effect=failure), self.assertRaises(ValueError) as error:
                provisioner.api("https://storage.googleapis.com/test")
            self.assertNotIn("synthetic-sensitive", str(error.exception))
            self.assertIn("synthetic-sensitive-detail", provisioner.log.read_text())
            self.assertTrue(failure.fp.closed)

    def test_missing_first_build_tag_is_a_closed_404_response_not_a_setup_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            provisioner = setup.Provisioner(configuration(), Path(directory))
            provisioner.token = "synthetic-token"
            provisioner.token_time = setup.time.monotonic()
            failure = urllib.error.HTTPError("https://artifactregistry.googleapis.com/test", 404, "Not found", {}, io.BytesIO(b"synthetic-resource-not-found"))
            with patch.object(setup.urllib.request, "urlopen", side_effect=failure):
                self.assertIsNone(provisioner.api("https://artifactregistry.googleapis.com/test", missing=True))
            self.assertTrue(failure.fp.closed)


if __name__ == "__main__":
    unittest.main()
