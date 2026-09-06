"""Offline tests for provisioning boundaries; never contact cloud APIs."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("deploy", HERE / "deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def fixture():
    config = json.loads((HERE / "config.example.json").read_text())
    config["PROJECT_ID"] = "test-carbon"
    return config


SECRETS = {"CLOUDFLARE_API_TOKEN": "test-token", "GOOGLE_CLIENT_ID": "test.apps.googleusercontent.com", "GOOGLE_CLIENT_SECRET": "test-secret"}


class ValidationTests(unittest.TestCase):
    def test_valid_private_configuration(self):
        self.assertEqual(deploy.validate(fixture(), SECRETS)["REGION"], "us-east1")

    def test_invalid_configuration_fails_closed(self):
        cases = [("REGION", "us-east-1"), ("ZONE", "us-west1-a"), ("ERP_HOST", "erp.other.com"),
                 ("ERP_HOST", "erp.example.com\n{ malicious }"), ("DATA_DISK_GB", 5),
                 ("PROJECT_ID", None), ("VM_NAME", "bad;cmd"), ("MACHINE_TYPE", "x$(cmd)"),
                 ("ACME_EMAIL", "bad"), ("SOURCE_REPO_URL", "https://user:secret@github.com/test/carbon")]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                config = fixture()
                config[key] = value
                with self.assertRaises(ValueError):
                    deploy.validate(config, SECRETS)

    def test_duplicate_hosts_rejected(self):
        config = fixture()
        config["MES_HOST"] = config["ERP_HOST"]
        with self.assertRaises(ValueError):
            deploy.validate(config, SECRETS)

    def test_missing_or_placeholder_secrets_rejected(self):
        for secrets in ({}, {**SECRETS, "GOOGLE_CLIENT_SECRET": "replace-secret"}, {**SECRETS, "CLOUDFLARE_API_TOKEN": []}):
            with self.assertRaises(ValueError):
                deploy.validate(fixture(), secrets)

    def test_world_readable_configuration_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "config.json"
            p.write_text("{}")
            p.chmod(0o644)
            with self.assertRaises(ValueError):
                deploy.private_json(p)
            p.chmod(0o600)
            self.assertEqual(deploy.private_json(p), {})

    def test_tracked_configuration_rejected_even_if_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            p = root / "config.json"
            p.write_text("{}")
            p.chmod(0o600)
            with patch.object(deploy, "REPO", root), patch.object(deploy, "run", return_value="config.json"), patch.object(deploy.subprocess, "run") as mock:
                mock.return_value.returncode = 0
                with self.assertRaises(ValueError):
                    deploy.private_json(p)


class ProvisioningTests(unittest.TestCase):
    def test_new_vm_has_no_public_address_and_retained_disk(self):
        cloud = deploy.Cloud(fixture())
        calls = []
        def get(*args):
            if args[:3] == ("compute", "disks", "describe"):
                return {}
            return []
        with patch.object(cloud, "get", side_effect=get), patch.object(cloud, "call", side_effect=lambda *args, **kw: calls.append(args)), patch.object(cloud, "check_vm"), patch.object(cloud, "check_firewall"):
            cloud.provision()
        vm = next(c for c in calls if c[:3] == ("compute", "instances", "create"))
        self.assertIn("--no-address", vm)
        self.assertIn("--no-service-account", vm)
        self.assertIn("--deletion-protection", vm)
        self.assertIn("name=carbon-data,device-name=carbon-data,mode=rw,boot=no,auto-delete=no", vm)
        rules = [c for c in calls if c[:3] == ("compute", "firewall-rules", "create")]
        self.assertEqual(len(rules), 2)
        self.assertIn("--source-ranges=35.235.240.0/20", rules[0])
        self.assertIn("--rules=tcp:22", rules[0])
        self.assertIn("--action=DENY", rules[1])
        self.assertFalse(any("tcp:443" in c or "tcp:80" in c for c in rules))

    def test_vm_drift_refused(self):
        cloud = deploy.Cloud(fixture())
        vm = {"networkInterfaces": [{"network": "/networks/carbon-vpc"}], "disks": [{"deviceName": "carbon-data", "autoDelete": False, "source": "/disks/carbon-data"}]}
        with patch.object(cloud, "get", return_value=vm):
            cloud.check_vm()
        for field, value in (("accessConfigs", [{}]), ("ipv6AccessConfigs", [{}]), ("network", "/networks/default")):
            drift = copy.deepcopy(vm)
            drift["networkInterfaces"][0][field] = value
            with patch.object(cloud, "get", return_value=drift), self.assertRaises(ValueError):
                cloud.check_vm()

    def test_firewall_drift_refused(self):
        cloud = deploy.Cloud(fixture())
        base = {"network": "/networks/carbon-vpc", "direction": "INGRESS", "targetTags": ["carbon"]}
        rules = [{**base, "name": "carbon-iap", "priority": 900, "allowed": [{"IPProtocol": "tcp", "ports": ["22"]}], "sourceRanges": ["35.235.240.0/20"]},
                 {**base, "name": "carbon-deny-ingress", "priority": 1000, "denied": [{"IPProtocol": "all"}], "sourceRanges": ["0.0.0.0/0"]}]
        with patch.object(cloud, "get", return_value=rules):
            cloud.check_firewall()
        variants = [[], [dict(rules[0], sourceRanges=["0.0.0.0/0"]), rules[1]],
                    [rules[0], dict(rules[1], disabled=True)],
                    [*rules, {**base, "name": "extra", "allowed": [{"IPProtocol": "all"}]}]]
        for drift in variants:
            with patch.object(cloud, "get", return_value=drift), self.assertRaises(ValueError):
                cloud.check_firewall()

    def test_cloud_errors_do_not_trigger_create(self):
        cloud = deploy.Cloud(fixture())
        with patch.object(cloud, "get", side_effect=OSError("network")), patch.object(cloud, "call") as create:
            with self.assertRaises(OSError):
                cloud.ensure(["instances"], "carbon", [])
            create.assert_not_called()

    def test_project_is_explicit_and_remote_args_are_quoted(self):
        cloud = deploy.Cloud(fixture())
        with patch.object(deploy, "run") as mock:
            cloud.ssh("printf", "%s", "$(not-executed)")
        argv = mock.call_args.args[0]
        self.assertIn("--tunnel-through-iap", argv)
        self.assertEqual(argv[argv.index("--project") + 1], "test-carbon")
        self.assertIn("'$(not-executed)'", argv[argv.index("--command") + 1])


class DnsTests(unittest.TestCase):
    def test_dns_is_private_address_and_never_proxied(self):
        cf = deploy.Cloudflare("synthetic")
        with patch.object(cf, "call", side_effect=[[], {}]) as api:
            cf.update("zone", "erp.example.com", "100.64.0.1")
        payload = api.call_args.args[1]
        self.assertEqual(payload["content"], "100.64.0.1")
        self.assertFalse(payload["proxied"])

    def test_conflicts_do_not_overwrite_existing_dns(self):
        cf = deploy.Cloudflare("synthetic")
        for record in ({"type": "CNAME"}, {"type": "AAAA"}, {"type": "A", "content": "203.0.113.1", "proxied": False}, {"type": "A", "content": "100.64.0.1", "proxied": True}):
            with patch.object(cf, "call", return_value=[record]) as api:
                with self.assertRaises(ValueError):
                    cf.update("zone", "erp.example.com", "100.64.0.1")
                self.assertEqual(api.call_count, 1)

    def test_redeploy_does_not_rewrite_matching_dns(self):
        cf = deploy.Cloudflare("synthetic")
        with patch.object(cf, "call", return_value=[{"type": "A", "content": "100.64.0.1", "proxied": False}]) as api:
            cf.update("zone", "erp.example.com", "100.64.0.1")
            self.assertEqual(api.call_count, 1)


if __name__ == "__main__":
    unittest.main()
