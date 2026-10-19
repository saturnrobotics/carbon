"""Exercise deployment orchestration offline, including automatic maintenance."""
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
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
    def run_release(self, planned, *, snapshot_error=None, events=None, final_check_error=None, fail_at=None, config=None):
        if config is None:
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
                events.append("tailscale-ip")
                return "100.64.0.10\n"
            if len(args) > 2 and str(args[2]).endswith("/bootstrap.sh"):
                events.append("bootstrap:" + ",".join(map(str, args[4:])))
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
        self.assertEqual(events, ["bootstrap:" + REVISION, "tailscale-ip", "prepare", "quiesce", "docker-stop", "snapshot",
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
        self.assertEqual(events, ["bootstrap:" + REVISION, "tailscale-ip", "prepare", "quiesce", "docker-stop", "snapshot",
                                  "docker-start", "start"])

    def test_erp_only_release_stays_routine_without_snapshot_or_quiesce(self):
        planned = plan()
        events, uploaded, cloud, publish, _, _, _ = self.run_release(planned)
        self.assertEqual(events, ["bootstrap:" + REVISION, "tailscale-ip", "prepare", "routine-apply", "check", "finalize"])
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


    def private_lb_config(self):
        from test_deploy import private_lb_fixture
        config = private_lb_fixture()
        config.update(CLOUDFLARE_API_TOKEN="synthetic-token")
        return config

    def test_private_lb_release_skips_tailnet_and_dns_but_keeps_certificate_access(self):
        for planned in (plan(generation=3, changed=False, maintenance_required=True), plan()):
            with self.subTest(maintenance=planned["maintenance_required"]):
                events, uploaded, cloud, publish, _, dns, _ = self.run_release(planned, config=self.private_lb_config())
                self.assertEqual(events[0], "bootstrap:" + REVISION + ",private-lb")
                self.assertNotIn("tailscale-ip", events)
                self.assertEqual(events[-2:], ["check", "finalize"])
                dns.return_value.zone.assert_called_once()
                dns.return_value.update.assert_not_called()
                self.assertEqual(uploaded[0]["INGRESS_MODE"], "private-lb")
                certificates = [call.args for call in cloud.ssh.call_args_list if str(call.args[-1]).endswith("/certificates.sh")]
                self.assertEqual(len(certificates), 1)

    def run_adoption(self):
        config = self.private_lb_config()
        events, uploaded = [], []
        cloud = MagicMock(spec=deploy.Cloud)

        def ssh(*args, **kwargs):
            if args[:2] == ("mktemp", "-d"):
                events.append("stage")
                return "/tmp/carbon-upload.synthetic\n"
            if args == ("true",):
                events.append("ssh-ready")
            elif len(args) > 2 and str(args[2]).endswith("/bootstrap.sh"):
                events.append("bootstrap:" + ",".join(map(str, args[4:])))
            elif len(args) > 2 and str(args[2]).endswith("/host-deploy.sh"):
                events.append("host:" + args[-1])
            elif args[:3] == ("rm", "-rf", "--"):
                events.append("cleanup")
            else:
                events.append("ssh:" + " ".join(map(str, args)))
            return ""

        cloud.ssh.side_effect = ssh
        cloud.provision.side_effect = lambda: events.append("provision")
        cloud.check_vm.side_effect = lambda: events.append("check-vm")
        cloud.check_firewall.side_effect = lambda: events.append("check-firewall")
        cloud.call.side_effect = lambda *args, **kwargs: events.append("call:" + " ".join(args))
        cloud.scp.side_effect = lambda source, destination: (
            uploaded.append(json.loads(Path(source).read_text())) if Path(source).name == "config.json" else None)
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(io.StringIO()))
            stack.enter_context(patch.object(deploy, "revision", return_value=REVISION))
            verification = stack.enter_context(patch.object(deploy.verify_source, "require_verified"))
            publish = stack.enter_context(patch.object(deploy, "publish_source"))
            factory = stack.enter_context(patch.object(deploy, "Cloud", return_value=cloud))
            dns = stack.enter_context(patch.object(deploy, "Cloudflare"))
            stack.enter_context(patch.object(deploy, "run"))
            deploy.adopt(config)
            publish.assert_not_called()
            dns.assert_not_called()
        return events, uploaded, verification, factory

    def test_adoption_bootstraps_the_copied_disk_and_starts_nothing(self):
        events, uploaded, verification, _ = self.run_adoption()
        verification.assert_called_once_with(self.private_lb_config()["SOURCE_REPO_URL"], REVISION)
        self.assertEqual(events, ["provision", "ssh-ready", "stage", "bootstrap:" + REVISION + ",private-lb",
                                  "host:adopt", "check-vm", "check-firewall", "cleanup"])
        self.assertEqual(uploaded[0]["DEPLOY_REVISION"], REVISION)
        self.assertNotIn("RELEASE_PLAN", uploaded[0])

    def test_adoption_without_verified_source_makes_no_cloud_request(self):
        with patch.object(deploy, "revision", return_value=REVISION), \
             patch.object(deploy.verify_source, "require_verified", side_effect=ValueError("CI evidence missing")), \
             patch.object(deploy, "Cloud") as factory:
            with self.assertRaisesRegex(ValueError, "CI evidence missing"):
                deploy.adopt(self.private_lb_config())
            factory.assert_not_called()


@unittest.skipIf(Path("/var/lib/carbon").exists(), "host-script tests need a machine without Carbon state")
class HostScriptIngressTests(unittest.TestCase):
    """Run host-deploy.sh with stub host commands; nothing touches Docker or the network."""

    def run_host(self, action, mode, *, address="10.73.8.2", running="", tailscale=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            stubs = {
                "id": "echo 0",
                "ip": f"printf '2: ens4    inet %s/32 scope global ens4\\n' '{address}'",
                "docker": f"printf '%s\\n' \"$*\" >> '{root}/docker.log'; if [ \"$1\" = ps ]; then printf '%s' '{running}'; fi",
            }
            if tailscale is not None:
                stubs["tailscale"] = tailscale
            for name, body in stubs.items():
                (bin_dir / name).write_text("#!/bin/sh\n" + body + "\n")
                (bin_dir / name).chmod(0o755)
            for name in ("python3", "bash", "grep", "cat"):
                (bin_dir / name).symlink_to(sys.executable if name == "python3" else shutil.which(name))
            config = {"DEPLOY_REVISION": REVISION, "POSTGRES_PRIVATE_IP": "10.73.8.2", "TAILSCALE_IP": "100.64.0.10"}
            if mode is not None:
                config["INGRESS_MODE"] = mode
            (root / "config.json").write_text(json.dumps(config))
            result = subprocess.run(["bash", str(HERE / "host-deploy.sh"), str(root / "config.json"), str(HERE.parents[2]), action],
                                    env={"PATH": str(bin_dir), "HOME": temporary}, capture_output=True, text=True, timeout=60)
            docker = (root / "docker.log").read_text() if (root / "docker.log").exists() else ""
        return result, docker

    def test_adoption_runs_only_in_private_lb_mode_and_starts_nothing(self):
        result, docker = self.run_host("adopt", "private-lb")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("nothing was started", result.stdout)
        self.assertNotIn(" up", docker)
        for mode in (None, "tailscale"):
            with self.subTest(mode=mode):
                result, docker = self.run_host("adopt", mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("only to INGRESS_MODE=private-lb", result.stderr)
                self.assertEqual(docker, "")

    def test_adoption_never_stops_a_running_stack(self):
        result, docker = self.run_host("adopt", "private-lb", running="synthetic-container")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("never stops a running stack", result.stderr)
        self.assertNotIn("down", docker)

    def test_private_lb_requires_the_private_address_and_no_tailscale(self):
        result, _ = self.run_host("prepare", "private-lb")
        # The ingress check passed; the next precondition (certificates) stops this stub host.
        self.assertIn("DNS-validated certificate", result.stderr)
        result, _ = self.run_host("prepare", "private-lb", address="10.73.8.3")
        self.assertIn("not on this VM's network interface", result.stderr)
        result, _ = self.run_host("prepare", "private-lb", tailscale="echo 100.64.0.10")
        self.assertIn("must not be installed", result.stderr)

    def test_tailscale_mode_still_verifies_the_tailnet_address(self):
        for mode in (None, "tailscale"):
            with self.subTest(mode=mode):
                result, _ = self.run_host("prepare", mode, tailscale="echo 100.64.0.99")
                self.assertIn("Configured Tailscale address does not match", result.stderr)
        result, _ = self.run_host("prepare", "public")
        self.assertIn("Invalid ingress mode", result.stderr)


if __name__ == "__main__":
    unittest.main()
