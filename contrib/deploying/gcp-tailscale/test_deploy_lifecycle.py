"""Exercise deployment orchestration offline, including automatic maintenance."""
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import MagicMock, patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("deploy_lifecycle_subject", HERE / "deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

REVISION = "c" * 40
BASES = {"NODE_IMAGE": "node:22@sha256:" + "a" * 64,
         "NODE_SLIM_IMAGE": "node:22-slim@sha256:" + "b" * 64}


def plan(generation=3, *, changed=True, maintenance_required=False):
    affected = {"erp": ["source changed"]} if changed else {}
    return {"expected_generation": generation, "build": affected,
            "configure": {}, "migrate": {}, "deploy": affected,
            "maintenance_required": maintenance_required, "services": {}}


class DeployLifecycleTests(unittest.TestCase):
    def run_release(self, planned, *, snapshot_error=None, events=None, final_check_error=None, fail_at=None):
        config = json.loads((HERE / "config.example.json").read_text())
        config.update(PROJECT_ID="example-project", CLOUDFLARE_API_TOKEN="synthetic-token")
        desired = {"prepared_source_commit": REVISION, "base_images": BASES}
        events = [] if events is None else events
        uploaded = []
        cloud = MagicMock(spec=deploy.Cloud)

        def ssh(*args, **kwargs):
            if args[:2] == ("mktemp", "-d"):
                return "/tmp/carbon-upload.synthetic\n"
            if args[:3] == ("sudo", "tailscale", "ip"):
                return "100.64.0.10\n"
            if len(args) > 2 and str(args[2]).endswith("/host-deploy.sh"):
                events.append(args[-1])
                if args[-1] == "check" and final_check_error is not None:
                    raise final_check_error
            elif args[:3] == ("sudo", "systemctl", "stop"):
                self.assertEqual(args[3:], ("docker.service", "docker.socket"))
                events.append("docker-stop")
            elif args[:3] == ("sudo", "systemctl", "start"):
                self.assertEqual(args[3:], ("docker.service",))
                events.append("docker-start")
            if args[:3] == ("rm", "-rf", "--") and fail_at == "cleanup":
                raise subprocess.CalledProcessError(1, ["synthetic-cleanup"])
            return ""

        def call(*args, **kwargs):
            self.assertEqual(args[:3], ("compute", "snapshots", "create"))
            events.append("snapshot")
            if snapshot_error is not None:
                raise snapshot_error

        def scp(source, destination):
            if Path(source).name == "config.json":
                self.assertEqual(Path(source).stat().st_mode & 0o777, 0o600)
                uploaded.append(json.loads(Path(source).read_text()))

        def archive(args, **kwargs):
            self.assertEqual(args[:4], ["git", "-C", str(deploy.REPO), "archive"])
            self.assertEqual(args[-1], REVISION)

        cloud.ssh.side_effect = ssh
        cloud.call.side_effect = call
        cloud.scp.side_effect = scp
        if fail_at == "vm":
            cloud.check_vm.side_effect = subprocess.CalledProcessError(1, ["synthetic-vm-check"])
        if fail_at == "firewall":
            cloud.check_firewall.side_effect = subprocess.CalledProcessError(1, ["synthetic-firewall-check"])
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(io.StringIO()))
            stack.enter_context(patch.object(deploy, "revision", return_value=REVISION))
            verification = stack.enter_context(patch.object(deploy.verify_source, "require_verified"))
            publish = stack.enter_context(patch.object(deploy, "publish_source"))
            factory = stack.enter_context(patch.object(deploy, "Cloud", return_value=cloud))
            dns = stack.enter_context(patch.object(deploy, "Cloudflare"))
            inference = stack.enter_context(patch.object(deploy.invoice_inference, "provision"))
            stack.enter_context(patch.object(deploy, "read_last_successful_manifest",
                                            return_value={"generation": planned["expected_generation"], "services": {}}))
            stack.enter_context(patch.object(deploy, "run", side_effect=archive))
            try:
                deploy.deploy(config, desired, prepared_release=planned)
                if publish.called:
                    verification.assert_called_once_with(config["SOURCE_REPO_URL"], REVISION)
                else:
                    verification.assert_not_called()
            except ValueError as exc:
                self.fail(f"Automatic deployment rejected a valid planned release: {exc}")
        return events, uploaded, cloud, publish, factory, dns, inference

    def assert_maintenance(self, planned):
        events, uploaded, cloud, publish, _, _, inference = self.run_release(planned)
        self.assertEqual(events, ["prepare", "quiesce", "docker-stop", "snapshot",
                                  "docker-start", "maintenance-apply", "check", "finalize"])
        publish.assert_called_once()
        cloud.provision.assert_called_once()
        inference.assert_called_once_with(cloud)
        cloud.check_vm.assert_called_once()
        cloud.check_firewall.assert_called_once()
        self.assertEqual(len(uploaded), 1)
        self.assertIs(uploaded[0]["RELEASE_MAINTENANCE"], True)
        self.assertEqual(uploaded[0]["RELEASE_PLAN"], planned)
        self.assertEqual(uploaded[0]["RELEASE_BASE_IMAGES"], BASES)

    def test_first_release_initializes_baseline_with_snapshot_without_flags(self):
        self.assert_maintenance(plan(generation=0, changed=False))

    def test_required_maintenance_runs_snapshot_without_flags(self):
        self.assert_maintenance(plan(generation=3, changed=False, maintenance_required=True))

    def test_snapshot_failure_resumes_existing_services_before_raising(self):
        events = []
        failure = subprocess.CalledProcessError(
            1, ["gcloud", "compute", "snapshots", "create", "synthetic-snapshot"])
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            self.run_release(plan(generation=3, maintenance_required=True),
                             snapshot_error=failure, events=events)
        self.assertIs(raised.exception, failure)
        self.assertEqual(events, ["prepare", "quiesce", "docker-stop", "snapshot",
                                  "docker-start", "start"])

    def test_erp_only_release_stays_routine_without_snapshot_or_quiesce(self):
        planned = plan()
        events, uploaded, cloud, publish, _, _, _ = self.run_release(planned)
        self.assertEqual(events, ["prepare", "routine-apply", "check", "finalize"])
        cloud.call.assert_not_called()
        publish.assert_called_once()
        self.assertEqual(len(uploaded), 1)
        self.assertIs(uploaded[0]["RELEASE_MAINTENANCE"], False)
        self.assertEqual(set(uploaded[0]["RELEASE_PLAN"]["deploy"]), {"erp"})
        self.assertEqual(uploaded[0]["RELEASE_BASE_IMAGES"], BASES)

    def test_final_verification_failure_never_finalizes_the_release(self):
        for maintenance in (False, True):
            with self.subTest(maintenance=maintenance):
                events = []
                failure = subprocess.CalledProcessError(1, ["synthetic-final-check"])
                with self.assertRaises(subprocess.CalledProcessError):
                    self.run_release(plan(maintenance_required=maintenance), events=events,
                                     final_check_error=failure)
                self.assertIn("check", events)
                self.assertNotIn("finalize", events)

    def test_cloud_check_or_cleanup_failure_never_finalizes_the_release(self):
        for maintenance in (False, True):
            for boundary in ("vm", "firewall", "cleanup"):
                with self.subTest(maintenance=maintenance, boundary=boundary):
                    events = []
                    with self.assertRaises(subprocess.CalledProcessError):
                        self.run_release(plan(maintenance_required=maintenance), events=events, fail_at=boundary)
                    self.assertNotIn("finalize", events)

    def test_finalization_is_the_last_remote_action_after_cleanup(self):
        events, uploaded, cloud, publish, factory, dns, inference = self.run_release(plan())
        calls = [call.args for call in cloud.ssh.call_args_list]
        self.assertEqual(calls[-1][-1], "finalize")
        self.assertEqual(calls[-2][:3], ("rm", "-rf", "--"))

    def test_unchanged_release_does_not_publish_or_provision(self):
        events, uploaded, cloud, publish, factory, dns, inference = self.run_release(plan(changed=False))
        self.assertEqual(events, [])
        self.assertEqual(uploaded, [])
        publish.assert_not_called()
        factory.assert_not_called()
        dns.assert_not_called()
        inference.assert_not_called()
        cloud.provision.assert_not_called()


if __name__ == "__main__":
    unittest.main()
