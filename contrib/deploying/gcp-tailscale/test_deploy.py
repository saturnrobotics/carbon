"""Offline tests for provisioning boundaries; never contact cloud APIs."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

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
    def test_unverified_revision_stops_before_publication_or_cloud_mutations(self):
        planned = {"expected_generation": 2, "build": {"erp": []}, "configure": {}, "migrate": {}, "deploy": {"erp": []}}
        with patch.object(deploy, "revision", return_value="a" * 40), \
             patch.object(deploy, "verify_source", create=True) as verification, \
             patch.object(deploy, "publish_source", side_effect=ValueError("published before verification")) as publish, \
             patch.object(deploy, "Cloud") as cloud:
            verification.require_verified.side_effect = ValueError("Fork verification is missing")
            with self.assertRaisesRegex(ValueError, "Fork verification is missing"):
                deploy.deploy(fixture(), {}, prepared_release=planned)
            publish.assert_not_called()
            cloud.assert_not_called()

    def test_force_skips_only_ci_and_retains_source_publication(self):
        planned = {
            "expected_generation": 2,
            "build": {"erp": []},
            "configure": {},
            "migrate": {},
            "deploy": {"erp": []},
        }
        with patch.object(deploy, "revision", return_value="a" * 40), patch.object(
            deploy.verify_source, "require_verified", side_effect=ValueError("CI unavailable")
        ) as verify, patch.object(
            deploy, "publish_source", side_effect=ValueError("source publication failed")
        ) as publish, patch.object(deploy, "Cloud") as cloud:
            with self.assertRaisesRegex(ValueError, "source publication failed"):
                deploy.deploy(fixture(), {}, prepared_release=planned, force=True)
            verify.assert_not_called()
            publish.assert_called_once()
            cloud.assert_not_called()

    def test_commit_change_during_preparation_stops_before_publication(self):
        for force in (False, True):
            desired = {"prepared_source_commit": "a" * 40}
            planned = {"expected_generation": 2, "build": {}, "configure": {}, "migrate": {}, "deploy": {}}
            with patch.object(deploy, "revision", return_value="b" * 40), patch.object(
                deploy, "publish_source"
            ) as publish:
                with self.assertRaisesRegex(ValueError, "Source changed"):
                    deploy.deploy(fixture(), desired, prepared_release=planned, force=force)
                publish.assert_not_called()

    def test_plan_prepares_automatically_without_deploying(self):
        with patch.object(deploy.sys, "argv", ["deploy.py", "--plan"]), \
             patch.object(deploy, "private_json", side_effect=[fixture(), SECRETS]), \
             patch.object(deploy.Path, "exists", return_value=False), \
             patch.object(deploy, "run", return_value="a" * 40), \
             patch("prepare_release.prepare", return_value=({}, {"build": {}, "configure": {}, "deploy": {}, "unchanged": {}})) as prepare, \
             patch.object(deploy, "deploy") as rollout:
            deploy.main()
            prepare.assert_called_once()
            rollout.assert_not_called()

    def test_apply_generates_inputs_without_reading_a_manual_manifest(self):
        for flags in ([], ["--force"]):
            desired = {"prepared_source_commit": "a" * 40}
            planned = {"build": {"erp": []}, "configure": {}, "deploy": {"erp": []}, "unchanged": {"mes": []}}
            with patch.object(deploy.sys, "argv", ["deploy.py", "--apply", *flags]), patch.object(
                deploy, "private_json", side_effect=[fixture(), SECRETS]
            ) as read, patch.object(deploy.Path, "exists", return_value=False), patch.object(
                deploy, "revision", return_value="a" * 40
            ), patch("prepare_release.prepare", return_value=(desired, planned)) as prepare, patch.object(
                deploy, "deploy"
            ) as rollout:
                deploy.main()
                self.assertEqual(read.call_count, 2)
                prepare.assert_called_once()
                self.assertEqual(rollout.call_args.kwargs["prepared_release"], planned)

            self.assertEqual(rollout.call_args.kwargs["force"], bool(flags))

    def test_force_requires_apply_before_reading_private_inputs(self):
        with patch.object(deploy.sys, "argv", ["deploy.py", "--plan", "--force"]), patch.object(
            deploy, "private_json"
        ) as read:
            with self.assertRaises(SystemExit) as failure:
                deploy.main()
            self.assertEqual(failure.exception.code, 2)
            read.assert_not_called()

    def test_noop_stops_before_publication_or_cloud_changes(self):
        planned = {"expected_generation": 2, "build": {}, "configure": {}, "migrate": {}, "deploy": {}}
        with patch.object(deploy, "revision", return_value="a" * 40), \
             patch.object(deploy, "publish_source") as publish, patch.object(deploy, "Cloud") as cloud:
            deploy.deploy(fixture(), {}, prepared_release=planned)
            publish.assert_not_called()
            cloud.assert_not_called()

    def test_missing_private_input_reports_actionable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "release-plan.json"
            with self.assertRaisesRegex(ValueError, r"Missing private configuration file: .*release-plan\.json"):
                deploy.private_json(missing)

    def test_valid_private_configuration(self):
        self.assertEqual(deploy.validate(fixture(), SECRETS)["REGION"], "us-east1")

    def test_optional_portal_receiver_inputs(self):
        registry = json.dumps({"version": 1, "receiver": {"id": "carbon-erp", "audience": "https://erp.hq.example.com"}, "callers": [{"callerId": "portal-query", "serviceAccountSubject": "synthetic-subject-1", "sourceIapAudience": "/projects/0/global/backendServices/0", "operations": ["portal_resolveItems"], "capabilities": ["portal.read"], "requiredAccessLevels": []}]})
        deploy.validate(fixture(), {**SECRETS, "PORTAL_TRUSTED_CALLERS_JSON": registry})
        config = fixture()
        del config["PORTAL_RECEIVER_AUDIENCE"]
        deploy.validate(config, SECRETS)
        with self.assertRaisesRegex(ValueError, "Unknown configuration keys"):
            deploy.validate({**fixture(), "PORTAL_RECEIVER_ID": "carbon-erp"}, SECRETS)
        with self.assertRaisesRegex(ValueError, "Unknown configuration keys"):
            deploy.validate(fixture(), {**SECRETS, "PORTAL_MACHINE_CALLERS_JSON": registry})

    def test_optional_hq_sign_in_inputs(self):
        hq_secret = {"HQ_OIDC_CARBON_SECRET": "synthetic-hq-client-secret-" + "x" * 16}
        self.assertEqual(fixture()["HQ_SIGN_IN_ENABLED"], "false")
        deploy.validate(fixture(), {**SECRETS, **hq_secret})
        enabled = {**fixture(), "HQ_SIGN_IN_ENABLED": "true"}
        self.assertEqual(deploy.validate(enabled, {**SECRETS, **hq_secret})["HQ_ISSUER"], "https://hq.example.com")
        deploy.validate({**enabled, "GOOGLE_SIGN_IN_ENABLED": "false"}, {**SECRETS, **hq_secret})
        for config, secrets in ((enabled, SECRETS),
                                (enabled, {**SECRETS, "HQ_OIDC_CARBON_SECRET": "replace-with-the-hq-oidc-client-secret"}),
                                (fixture(), {**SECRETS, "HQ_OIDC_CARBON_SECRET": "replace-with-the-hq-oidc-client-secret"}),
                                ({**fixture(), "GOOGLE_SIGN_IN_ENABLED": "false"}, SECRETS),
                                ({**enabled, "HQ_ISSUER": "https://hq.example.com/${PATH}"}, {**SECRETS, **hq_secret})):
            with self.subTest(config=config, secrets=sorted(secrets)), self.assertRaises(ValueError):
                deploy.validate(config, secrets)
        with self.assertRaisesRegex(ValueError, "Unknown configuration keys"):
            deploy.validate({**enabled, **hq_secret}, SECRETS)

    def test_optional_authz_api_claim_input(self):
        hq = {"HQ_SIGN_IN_ENABLED": "true"}
        hq_secret = {"HQ_OIDC_CARBON_SECRET": "synthetic-hq-client-secret-" + "x" * 16}
        self.assertEqual(fixture()["AUTHZ_API_CLAIM_REQUIRED"], "false")
        deploy.validate(fixture(), SECRETS)
        self.assertEqual(deploy.validate({**fixture(), **hq, "AUTHZ_API_CLAIM_REQUIRED": "true"},
                                         {**SECRETS, **hq_secret})["AUTHZ_API_CLAIM_REQUIRED"], "true")
        for config in ({**fixture(), "AUTHZ_API_CLAIM_REQUIRED": "true"},
                       {**fixture(), **hq, "AUTHZ_API_CLAIM_REQUIRED": "yes"},
                       {**fixture(), **hq, "AUTHZ_API_CLAIM_REQUIRED": True}):
            with self.subTest(config=config), self.assertRaisesRegex(ValueError, "AUTHZ_API_CLAIM_REQUIRED"):
                deploy.validate(config, {**SECRETS, **hq_secret})

    def test_optional_private_postgres_configuration(self):
        config = {**fixture(), "POSTGRES_PRIVATE_IP": "10.73.0.2", "POSTGRES_CLIENT_CIDRS": ["10.81.0.0/26"]}
        self.assertEqual(deploy.validate(config, SECRETS)["POSTGRES_CLIENT_CIDRS"], ["10.81.0.0/26"])
        for changes in ({"POSTGRES_PRIVATE_IP": None}, {"POSTGRES_PRIVATE_IP": "100.64.0.1"},
                        {"POSTGRES_PRIVATE_IP": "127.0.0.1"}, {"POSTGRES_PRIVATE_IP": "203.0.113.1"},
                        {"POSTGRES_CLIENT_CIDRS": ["10.81.0.0/23"]}, {"POSTGRES_CLIENT_CIDRS": []},
                        {"POSTGRES_CLIENT_CIDRS": ["0.0.0.0/0"]}, {"POSTGRES_CLIENT_CIDRS": "10.81.0.0/26"},
                        {"POSTGRES_CLIENT_CIDRS": ["10.81.0.1/26"]}, {"POSTGRES_CLIENT_CIDRS": ["10.81.0.0/26", "10.81.0.1/32"]},
                        {"POSTGRES_CLIENT_CIDRS": ["198.18.0.0/24"]}, {"POSTGRES_CLIENT_CIDRS": ["::1/128"]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                deploy.validate({**config, **changes}, SECRETS)
        for key in ("POSTGRES_PRIVATE_IP", "POSTGRES_CLIENT_CIDRS"):
            partial = dict(config)
            del partial[key]
            with self.assertRaisesRegex(ValueError, "together"):
                deploy.validate(partial, SECRETS)

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
    def test_error_capture_is_explicit_and_preserves_default_output(self):
        cloud = deploy.Cloud(fixture())
        with patch.object(deploy.subprocess, "run", return_value=MagicMock(stdout="captured")) as run:
            self.assertEqual(cloud.call("projects", "add-iam-policy-binding", "test-carbon", capture=True, capture_error=True), "captured")
            self.assertEqual(run.call_args.kwargs["stdout"], deploy.subprocess.PIPE)
            self.assertEqual(run.call_args.kwargs["stderr"], deploy.subprocess.PIPE)
            cloud.call("services", "enable", "aiplatform.googleapis.com")
            self.assertIsNone(run.call_args.kwargs["stdout"])
            self.assertIsNone(run.call_args.kwargs["stderr"])

    def private_config(self):
        return {**fixture(), "POSTGRES_PRIVATE_IP": "10.73.0.2", "POSTGRES_CLIENT_CIDRS": ["10.81.0.0/26"]}

    def test_private_postgres_firewall_does_not_weaken_drift_checks(self):
        cloud = deploy.Cloud(self.private_config())
        base = {"network": "/networks/carbon-vpc", "direction": "INGRESS", "targetTags": ["carbon"]}
        rules = [{**base, "name": "carbon-iap", "priority": 900, "allowed": [{"IPProtocol": "tcp", "ports": ["22"]}], "sourceRanges": ["35.235.240.0/20"]},
                 {**base, "name": "carbon-deny-ingress", "priority": 1000, "denied": [{"IPProtocol": "all"}], "sourceRanges": ["0.0.0.0/0"]},
                 {**base, "name": "carbon-postgres", "priority": 900, "allowed": [{"IPProtocol": "tcp", "ports": ["5432"]}], "sourceRanges": ["10.81.0.0/26"]}]
        with patch.object(cloud, "get", return_value=rules):
            cloud.check_firewall()
        for changes in ({"sourceRanges": ["10.0.0.0/8"]}, {"targetTags": []}, {"disabled": True},
                        {"allowed": [{"IPProtocol": "all"}]}, {"priority": 800}, {"sourceTags": ["other"]}):
            with patch.object(cloud, "get", return_value=[*rules[:2], {**rules[2], **changes}]), self.assertRaises(ValueError):
                cloud.check_firewall()
        with patch.object(cloud, "get", return_value=[*rules, {**base, "name": "extra", "allowed": [{"IPProtocol": "all"}]}]), self.assertRaises(ValueError):
            cloud.check_firewall()
        # Removing the config does not silently leave a database firewall open.
        other = deploy.Cloud(fixture())
        with patch.object(other, "get", return_value=rules), self.assertRaises(ValueError):
            other.check_firewall()

    def test_private_postgres_vm_address_must_match(self):
        cloud = deploy.Cloud(self.private_config())
        vm = {"networkInterfaces": [{"network": "/networks/carbon-vpc", "networkIP": "10.73.0.2"}], "disks": [{"deviceName": "carbon-data", "autoDelete": False, "source": "/disks/carbon-data"}]}
        with patch.object(cloud, "get", return_value=vm):
            cloud.check_vm()
        vm["networkInterfaces"][0]["networkIP"] = "10.73.0.3"
        with patch.object(cloud, "get", return_value=vm), self.assertRaisesRegex(ValueError, "must match"):
            cloud.check_vm()

    def test_private_postgres_address_is_reserved_and_verified(self):
        cloud = deploy.Cloud(self.private_config())
        address = {"addressType": "INTERNAL", "address": "10.73.0.2", "subnetwork": "/subnetworks/carbon-subnet", "users": ["/zones/us-east1-b/instances/carbon"]}
        with patch.object(cloud, "ensure") as ensure, patch.object(cloud, "get", return_value=address):
            cloud.reserve_postgres_address()
            self.assertIn("--subnet", ensure.call_args.args[2])
            self.assertIn("10.73.0.2", ensure.call_args.args[2])
        for changes in ({"addressType": "EXTERNAL"}, {"address": "10.73.0.3"}, {"subnetwork": "/subnetworks/other"}, {"users": ["/instances/other"]}):
            with patch.object(cloud, "ensure"), patch.object(cloud, "get", return_value={**address, **changes}), self.assertRaises(ValueError):
                cloud.reserve_postgres_address()

    def test_provision_creates_only_narrow_private_database_ingress(self):
        cloud = deploy.Cloud(self.private_config())
        calls = []
        with patch.object(cloud, "get", side_effect=lambda *args: {} if args[:3] == ("compute", "disks", "describe") else []), patch.object(cloud, "call", side_effect=lambda *args, **kw: calls.append(args)), patch.object(cloud, "check_vm"), patch.object(cloud, "check_firewall"), patch.object(cloud, "reserve_postgres_address") as reserve:
            cloud.provision()
        rule = next(call for call in calls if call[:4] == ("compute", "firewall-rules", "create", "carbon-postgres"))
        self.assertIn("--rules=tcp:5432", rule)
        self.assertEqual(rule[rule.index("--source-ranges") + 1], "10.81.0.0/26")
        self.assertIn("--priority=900", rule)
        vm = next(call for call in calls if call[:3] == ("compute", "instances", "create"))
        self.assertEqual(vm[vm.index("--private-network-ip") + 1], "10.73.0.2")
        reserve.assert_called_once()

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


ACCOUNT = "carbon-vm@test-carbon.iam.gserviceaccount.com"


def private_lb_fixture():
    """A synthetic private-lb configuration; documentation and RFC1918 ranges only."""
    config = fixture()
    for key in ("TAILSCALE_HOSTNAME", "PORTAL_RECEIVER_AUDIENCE"):
        del config[key]
    config.update({
        "INGRESS_MODE": "private-lb", "NETWORK": "shared-vpc", "SUBNET": "shared-data",
        "SERVICE_ACCOUNT": ACCOUNT, "POSTGRES_PRIVATE_IP": "10.73.8.2", "POSTGRES_CLIENT_CIDRS": ["10.81.0.0/24"],
        "INGRESS_ALLOWLIST": [
            {"name": "shared-allow-proxy-to-carbon", "priority": 1000, "ports": ["tcp:443"], "sources": ["10.73.4.0/26"], "target": ACCOUNT},
            {"name": "shared-allow-hc-to-carbon", "priority": 1000, "ports": ["tcp:443"], "sources": ["35.191.0.0/16", "130.211.0.0/22"], "target": ACCOUNT},
            {"name": "shared-allow-run-to-postgres", "priority": 1000, "ports": ["tcp:5432"], "sources": ["10.81.0.0/24"], "target": ACCOUNT},
            {"name": "shared-allow-iap-ssh-carbon", "priority": 1000, "ports": ["tcp:22"], "sources": ["35.235.240.0/20"], "target": ACCOUNT},
        ],
    })
    return config


def firewall_rules(config):
    """The GCP firewall listing that exactly matches the configured allowlist."""
    return [{"name": rule["name"], "network": "https://www.googleapis.com/compute/v1/projects/test-carbon/global/networks/" + config["NETWORK"],
             "direction": "INGRESS", "priority": rule["priority"],
             "allowed": [{"IPProtocol": port.split(":")[0], "ports": [port.split(":")[1]]} for port in rule["ports"]],
             "sourceRanges": list(rule["sources"]), "targetServiceAccounts": [rule["target"]],
             "logConfig": {"enable": True}} for rule in config["INGRESS_ALLOWLIST"]]


def private_vm(config):
    return {"networkInterfaces": [{"network": "/global/networks/shared-vpc", "subnetwork": "/regions/us-east1/subnetworks/shared-data", "networkIP": "10.73.8.2"}],
            "serviceAccounts": [{"email": config["SERVICE_ACCOUNT"], "scopes": ["https://www.googleapis.com/auth/cloud-platform"]}],
            "disks": [{"deviceName": "carbon-data", "autoDelete": False, "source": "/zones/us-east1-b/disks/carbon-data"}]}


class TailscaleModeTests(unittest.TestCase):
    """The default mode's provisioning is pinned to the calls made before private-lb existed."""

    EXPECTED = [
        ("services", "enable", "compute.googleapis.com", "iap.googleapis.com"),
        ("compute", "networks", "create", "carbon-vpc", "--subnet-mode=custom"),
        ("compute", "networks", "subnets", "create", "carbon-subnet", "--network", "carbon-vpc", "--region", "us-east1", "--range=10.73.0.0/24", "--enable-private-ip-google-access"),
        ("compute", "routers", "create", "carbon-router", "--network", "carbon-vpc", "--region", "us-east1"),
        ("compute", "routers", "nats", "create", "carbon-nat", "--router", "carbon-router", "--region", "us-east1", "--nat-all-subnet-ip-ranges", "--auto-allocate-nat-external-ips"),
        ("compute", "firewall-rules", "create", "carbon-iap", "--network", "carbon-vpc", "--direction=INGRESS", "--priority=900", "--action=ALLOW", "--rules=tcp:22", "--source-ranges=35.235.240.0/20", "--target-tags", "carbon"),
        ("compute", "firewall-rules", "create", "carbon-deny-ingress", "--network", "carbon-vpc", "--direction=INGRESS", "--priority=1000", "--action=DENY", "--rules=all", "--source-ranges=0.0.0.0/0", "--target-tags", "carbon"),
        ("compute", "disks", "create", "carbon-data", "--zone", "us-east1-b", "--size", "200GB", "--type=pd-balanced", "--labels=application=carbon"),
        ("compute", "resource-policies", "create", "snapshot-schedule", "carbon-daily", "--region", "us-east1", "--daily-schedule", "--start-time=06:00", "--max-retention-days=14", "--on-source-disk-delete=keep-auto-snapshots", "--storage-location", "us-east1"),
        ("compute", "disks", "add-resource-policies", "carbon-data", "--zone", "us-east1-b", "--resource-policies", "carbon-daily"),
        ("compute", "instances", "create", "carbon", "--zone", "us-east1-b", "--machine-type", "e2-standard-4", "--subnet", "carbon-subnet", "--no-address", "--no-service-account", "--no-scopes", "--image-family=debian-12", "--image-project=debian-cloud", "--boot-disk-size=50GB", "--disk", "name=carbon-data,device-name=carbon-data,mode=rw,boot=no,auto-delete=no", "--tags", "carbon", "--metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE", "--shielded-secure-boot", "--deletion-protection"),
    ]

    def provision_calls(self, config):
        cloud = deploy.Cloud(config)
        calls = []
        with patch.object(cloud, "get", side_effect=lambda *args: {} if args[:3] == ("compute", "disks", "describe") else []), \
             patch.object(cloud, "call", side_effect=lambda *args, **kw: calls.append(args)), \
             patch.object(cloud, "check_vm"), patch.object(cloud, "check_firewall"):
            cloud.provision()
        return calls

    def test_provisioning_is_unchanged_with_and_without_the_mode_key(self):
        implicit = fixture()
        del implicit["INGRESS_MODE"]
        self.assertFalse(deploy.private_lb.enabled(implicit))
        self.assertEqual(deploy.validate(implicit, SECRETS)["VM_NAME"], "carbon")
        for config in (implicit, fixture()):
            with self.subTest(mode=config.get("INGRESS_MODE")):
                self.assertEqual(self.provision_calls(config), self.EXPECTED)

    def test_private_lb_keys_are_rejected_in_tailscale_mode(self):
        lb = private_lb_fixture()
        for key in ("NETWORK", "SUBNET", "SERVICE_ACCOUNT", "INGRESS_ALLOWLIST"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "only to INGRESS_MODE=private-lb"):
                deploy.validate({**fixture(), key: lb[key]}, SECRETS)
        with self.assertRaisesRegex(ValueError, "INGRESS_MODE must be"):
            deploy.validate({**fixture(), "INGRESS_MODE": "public"}, SECRETS)

    def test_bootstrap_invocation_is_unchanged(self):
        self.assertEqual(deploy.private_lb.bootstrap_args(fixture()), ())
        self.assertEqual(deploy.private_lb.bootstrap_args(private_lb_fixture()), ("private-lb",))


class PrivateLbValidationTests(unittest.TestCase):
    def test_valid_private_lb_configuration(self):
        config = deploy.validate(private_lb_fixture(), SECRETS)
        self.assertEqual(config["NETWORK"], "shared-vpc")
        rules = deploy.private_lb.allowlist(config)
        self.assertEqual([rule["name"] for rule in rules], [rule["name"] for rule in private_lb_fixture()["INGRESS_ALLOWLIST"]])
        self.assertEqual(rules[1]["sources"], ["130.211.0.0/22", "35.191.0.0/16"])
        self.assertEqual(deploy.private_lb.trusted_proxies(rules, ACCOUNT), ["10.73.4.0/26"])

    def test_tailscale_and_portal_inputs_are_rejected(self):
        registry = json.dumps({"version": 1, "receiver": {"id": "carbon-erp", "audience": "https://erp.hq.example.com"}, "callers": [{"callerId": "portal-query", "serviceAccountSubject": "synthetic-subject-1", "sourceIapAudience": "/projects/0/global/backendServices/0", "operations": ["portal_resolveItems"], "capabilities": ["portal.read"], "requiredAccessLevels": []}]})
        audience = {**private_lb_fixture(), "PORTAL_RECEIVER_AUDIENCE": "https://erp.hq.example.com"}
        cases = {"hostname": ({**private_lb_fixture(), "TAILSCALE_HOSTNAME": "carbon"}, SECRETS),
                 "auth key": (private_lb_fixture(), {**SECRETS, "TAILSCALE_AUTH_KEY": "synthetic-key"}),
                 "tailnet address": ({**private_lb_fixture(), "TAILSCALE_IP": "100.64.0.1"}, SECRETS),
                 "portal audience": (audience, SECRETS),
                 "portal registry": (audience, {**SECRETS, "PORTAL_TRUSTED_CALLERS_JSON": registry})}
        for label, (config, secrets) in cases.items():
            with self.subTest(label), self.assertRaisesRegex(ValueError, "private-lb|Unknown configuration keys"):
                deploy.validate(config, secrets)
        self.assertEqual(deploy.validate({**fixture(), "PORTAL_RECEIVER_AUDIENCE": "https://erp.hq.example.com"},
                                         {**SECRETS, "PORTAL_TRUSTED_CALLERS_JSON": registry})["VM_NAME"], "carbon")

    def test_required_private_lb_keys(self):
        for key in ("NETWORK", "SUBNET", "SERVICE_ACCOUNT", "INGRESS_ALLOWLIST", "POSTGRES_PRIVATE_IP", "POSTGRES_CLIENT_CIDRS"):
            config = private_lb_fixture()
            del config[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                deploy.validate(config, SECRETS)

    def test_names_and_service_account_are_validated(self):
        for key, value in (("NETWORK", "Shared VPC"), ("SUBNET", "subnet;rm"), ("SERVICE_ACCOUNT", "carbon-vm"),
                           ("SERVICE_ACCOUNT", "carbon-vm@other-project.iam.gserviceaccount.com"),
                           ("SERVICE_ACCOUNT", "someone@example.com")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                deploy.validate({**private_lb_fixture(), key: value}, SECRETS)

    def test_allowlist_rejects_broad_tagged_or_inconsistent_rules(self):
        def changed(index, **changes):
            config = private_lb_fixture()
            config["INGRESS_ALLOWLIST"] = copy.deepcopy(config["INGRESS_ALLOWLIST"])
            config["INGRESS_ALLOWLIST"][index].update(changes)
            return config

        def without(index):
            config = private_lb_fixture()
            del config["INGRESS_ALLOWLIST"][index]
            return config

        duplicate = private_lb_fixture()
        duplicate["INGRESS_ALLOWLIST"][1]["name"] = duplicate["INGRESS_ALLOWLIST"][0]["name"]
        extra_key = changed(0)
        extra_key["INGRESS_ALLOWLIST"][0]["targetTags"] = ["carbon"]
        cases = {
            "everywhere": changed(1, sources=["0.0.0.0/0"]), "wide": changed(1, sources=["35.0.0.0/8"]),
            "non-canonical": changed(0, sources=["10.73.4.1/26"]), "ipv6": changed(0, sources=["::/0"]),
            "all ports": changed(0, ports=["all"]), "range": changed(0, ports=["tcp:443-445"]),
            "port zero": changed(0, ports=["tcp:0"]), "icmp": changed(0, ports=["icmp"]),
            "tag target": changed(0, target="carbon"), "user target": changed(0, target="someone@example.com"),
            "string priority": changed(0, priority="1000"), "boolean priority": changed(0, priority=True),
            "duplicate": duplicate, "extra key": extra_key, "empty": {**private_lb_fixture(), "INGRESS_ALLOWLIST": []},
            # Supabase's own pg_hba.conf admits other sources; the firewall must admit exactly the TLS clients.
            "database widened": changed(2, sources=["10.81.0.0/24", "10.82.0.0/24"]),
            "database missing": without(2),
            "no proxy subnet": without(0),
        }
        for label, config in cases.items():
            with self.subTest(label), self.assertRaises(ValueError):
                deploy.validate(config, SECRETS)

    def test_unmanaged_features_are_refused(self):
        with self.assertRaisesRegex(ValueError, "backups"):
            deploy.private_lb.check_unmanaged(private_lb_fixture(), backups=True)
        with self.assertRaisesRegex(ValueError, "invoice intake"):
            deploy.private_lb.check_unmanaged({**private_lb_fixture(), "INVOICE_INTAKE_ENABLED": "true"})
        deploy.private_lb.check_unmanaged(fixture(), backups=True)
        deploy.private_lb.check_unmanaged({**private_lb_fixture(), "INVOICE_INTAKE_ENABLED": "false"})

    def test_backups_are_refused_before_any_cloud_request(self):
        for flags in ([], ["--plan"], ["--adopt"]):
            with self.subTest(flags=flags), patch.object(deploy.sys, "argv", ["deploy.py", *flags]), \
                 patch.object(deploy, "private_json", side_effect=[private_lb_fixture(), SECRETS, {}]), \
                 patch.object(deploy.Path, "exists", return_value=True), \
                 patch.object(deploy.invoice_inference, "configuration", side_effect=lambda config, settings: config), \
                 patch.object(deploy, "Cloud") as cloud:
                with self.assertRaisesRegex(ValueError, "backups"):
                    deploy.main()
                cloud.assert_not_called()

    def test_adopt_is_private_lb_only_and_takes_no_release_options(self):
        with patch.object(deploy, "revision") as revision, patch.object(deploy, "Cloud") as cloud:
            with self.assertRaisesRegex(ValueError, "only to INGRESS_MODE=private-lb"):
                deploy.adopt(fixture())
            revision.assert_not_called()
            cloud.assert_not_called()
        for flags in (["--adopt", "--maintenance"], ["--adopt", "--apply"], ["--adopt", "--force"]):
            with self.subTest(flags=flags), patch.object(deploy.sys, "argv", ["deploy.py", *flags]), \
                 patch.object(deploy, "private_json") as read, self.assertRaises(SystemExit):
                deploy.main()
            read.assert_not_called()

    def test_private_lb_deploy_requires_an_adopted_vm(self):
        planned = {"expected_generation": 0, "build": {}, "configure": {}, "migrate": {}, "deploy": {}}
        cloud = MagicMock()
        cloud.get.return_value = []
        with patch.object(deploy, "revision", return_value="a" * 40), patch.object(deploy, "Cloud", return_value=cloud), \
             patch.object(deploy.verify_source, "require_verified") as verify, patch.object(deploy, "publish_source") as publish:
            with self.assertRaisesRegex(ValueError, "make deploy-adopt"):
                deploy.deploy(private_lb_fixture(), {}, prepared_release=planned)
            verify.assert_not_called()
            publish.assert_not_called()
            cloud.provision.assert_not_called()
        with patch.object(deploy, "revision", return_value="a" * 40), patch.object(deploy, "Cloud") as factory, \
             patch.object(deploy, "publish_source") as publish:
            with self.assertRaisesRegex(ValueError, "invoice intake"):
                deploy.deploy({**private_lb_fixture(), "INVOICE_INTAKE_ENABLED": "true"}, {}, prepared_release=planned)
            factory.assert_not_called()
            publish.assert_not_called()


class PrivateLbProvisioningTests(unittest.TestCase):
    """private-lb creates only the instance and its snapshot schedule."""

    def world(self, config, *, missing=(), changes=None):
        changes = changes or {}
        resources = {
            "networks": [{"name": "shared-vpc"}],
            "subnets": [{"name": "shared-data", "network": "/global/networks/shared-vpc"}],
            "addresses": [{"name": "carbon-ip", "addressType": "INTERNAL", "address": "10.73.8.2", "subnetwork": "/regions/us-east1/subnetworks/shared-data"}],
            "service-accounts": [{"email": config["SERVICE_ACCOUNT"]}],
            "disks": [{"name": "carbon-data", "users": []}],
            "firewall-rules": firewall_rules(config),
        }
        for kind, value in changes.items():
            resources[kind] = value
        for kind in missing:
            resources[kind] = []

        def get(*args):
            if args[:3] == ("compute", "networks", "list"):
                return resources["networks"]
            if args[:4] == ("compute", "networks", "subnets", "list"):
                return resources["subnets"]
            if args[:3] == ("compute", "addresses", "list"):
                return resources["addresses"]
            if args[:3] == ("iam", "service-accounts", "list"):
                return resources["service-accounts"]
            if args[:3] == ("compute", "disks", "list"):
                return resources["disks"]
            if args[:3] == ("compute", "disks", "describe"):
                return {}
            if args[:3] == ("compute", "firewall-rules", "list"):
                return resources["firewall-rules"]
            if args[:3] in (("compute", "resource-policies", "list"), ("compute", "instances", "list")):
                return []
            if args[:3] == ("compute", "instances", "describe"):
                return private_vm(config)
            raise AssertionError(f"unexpected cloud read {args}")
        return get

    def provision(self, config, **world):
        cloud = deploy.Cloud(config)
        calls = []
        with patch.object(cloud, "get", side_effect=self.world(config, **world)), \
             patch.object(cloud, "call", side_effect=lambda *args, **kw: calls.append(args)):
            try:
                cloud.provision()
            except ValueError as exc:
                return calls, str(exc)
        return calls, None

    def test_missing_data_disk_is_refused_and_never_created(self):
        calls, error = self.provision(private_lb_fixture(), missing=["disks"])
        self.assertRegex(error, "carbon-data is missing.*never creates a blank one")
        self.assertEqual(calls, [])

    def test_shared_resources_must_already_exist(self):
        for kind in ("networks", "subnets", "addresses", "service-accounts"):
            with self.subTest(kind=kind):
                calls, error = self.provision(private_lb_fixture(), missing=[kind])
                self.assertIsNotNone(error)
                self.assertEqual(calls, [])

    def test_shared_resources_must_match(self):
        address = {"name": "carbon-ip", "addressType": "INTERNAL", "address": "10.73.8.2", "subnetwork": "/regions/us-east1/subnetworks/shared-data"}
        cases = {
            "subnet in other network": {"subnets": [{"name": "shared-data", "network": "/global/networks/other"}]},
            "external address": {"addresses": [{**address, "addressType": "EXTERNAL"}]},
            "other address": {"addresses": [{**address, "address": "10.73.8.3"}]},
            "address in other subnet": {"addresses": [{**address, "subnetwork": "/subnetworks/other"}]},
            "address used elsewhere": {"addresses": [{**address, "users": ["/zones/us-east1-b/instances/other"]}]},
            "disabled account": {"service-accounts": [{"email": ACCOUNT, "disabled": True}]},
            "disk attached elsewhere": {"disks": [{"name": "carbon-data", "users": ["/zones/us-east1-b/instances/other"]}]},
            "similar disk name": {"disks": [{"name": "carbon-data-old", "users": []}]},
            "firewall drift": {"firewall-rules": [*firewall_rules(private_lb_fixture()), {"name": "allow-all", "network": "/global/networks/shared-vpc", "direction": "INGRESS", "priority": 900, "allowed": [{"IPProtocol": "all"}], "sourceRanges": ["0.0.0.0/0"]}]},
        }
        for label, changes in cases.items():
            with self.subTest(label):
                calls, error = self.provision(private_lb_fixture(), changes=changes)
                self.assertIsNotNone(error)
                self.assertEqual(calls, [])

    def test_creates_only_the_instance_and_snapshot_schedule(self):
        calls, error = self.provision(private_lb_fixture())
        self.assertIsNone(error)
        self.assertEqual([call[:3] for call in calls], [("compute", "resource-policies", "create"),
                                                        ("compute", "disks", "add-resource-policies"),
                                                        ("compute", "instances", "create")])
        self.assertEqual(calls[0][4], "carbon-daily")
        vm = calls[2]
        for flag in ("--no-address", "--scopes=cloud-platform", "--shielded-secure-boot", "--deletion-protection",
                     "--metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE",
                     "name=carbon-data,device-name=carbon-data,mode=rw,boot=no,auto-delete=no"):
            self.assertIn(flag, vm)
        self.assertEqual(vm[vm.index("--subnet") + 1], "shared-data")
        self.assertEqual(vm[vm.index("--private-network-ip") + 1], "10.73.8.2")
        self.assertEqual(vm[vm.index("--service-account") + 1], ACCOUNT)
        self.assertEqual(vm[vm.index("--tags") + 1], "carbon")
        self.assertNotIn("--no-service-account", vm)
        # The owning platform's data-plane contract checks these labels.
        self.assertEqual([flag for flag in vm if flag.startswith("--labels")], ["--labels=app=hq,role=data"])

    def check_firewall(self, rules):
        cloud = deploy.Cloud(private_lb_fixture())
        with patch.object(cloud, "get", return_value=rules):
            cloud.check_firewall()

    def test_ingress_rules_must_equal_the_allowlist(self):
        exact = firewall_rules(private_lb_fixture())
        egress = {"name": "deny-data", "network": exact[0]["network"], "direction": "EGRESS", "priority": 1000, "denied": [{"IPProtocol": "all"}], "destinationRanges": ["10.73.8.0/28"]}
        elsewhere = {**exact[0], "name": "other-network-rule", "network": "/global/networks/default", "sourceRanges": ["0.0.0.0/0"]}
        disabled = {**exact[0], "name": "parked-rule", "disabled": True, "sourceRanges": ["0.0.0.0/0"]}
        self.check_firewall([*reversed(exact), egress, elsewhere, disabled])

        def altered(**changes):
            return [{**exact[0], **changes}, *exact[1:]]

        variants = {
            "missing rule": exact[1:],
            "extra allow": [*exact, {**exact[0], "name": "extra"}],
            "extra deny": [*exact, {"name": "extra-deny", "network": exact[0]["network"], "direction": "INGRESS", "priority": 100, "denied": [{"IPProtocol": "tcp", "ports": ["443"]}], "sourceRanges": ["10.0.0.0/8"]}],
            "priority": altered(priority=900), "ports": altered(allowed=[{"IPProtocol": "tcp", "ports": ["443", "80"]}]),
            "all ports": altered(allowed=[{"IPProtocol": "tcp"}]),
            "widened sources": altered(sourceRanges=["10.73.0.0/16"]),
            "tag target": altered(targetServiceAccounts=None, targetTags=["carbon"]),
            "tag and account": altered(targetTags=["carbon"]),
            "other account": altered(targetServiceAccounts=["other-vm@test-carbon.iam.gserviceaccount.com"]),
            "all instances": altered(targetServiceAccounts=None),
            "disabled": altered(disabled=True),
            "source tags": altered(sourceTags=["router"]),
            "source accounts": altered(sourceServiceAccounts=[ACCOUNT]),
            "destination ranges": altered(destinationRanges=["10.73.8.2/32"]),
        }
        for label, rules in variants.items():
            with self.subTest(label), self.assertRaisesRegex(ValueError, "review it before deploying"):
                self.check_firewall(rules)

    def test_vm_contract(self):
        config = private_lb_fixture()
        cloud = deploy.Cloud(config)
        with patch.object(cloud, "get", return_value=private_vm(config)):
            cloud.check_vm()
        nic = private_vm(config)["networkInterfaces"][0]
        variants = {
            "external address": {"networkInterfaces": [{**nic, "accessConfigs": [{}]}]},
            "two interfaces": {"networkInterfaces": [nic, nic]},
            "other network": {"networkInterfaces": [{**nic, "network": "/global/networks/default"}]},
            "other subnet": {"networkInterfaces": [{**nic, "subnetwork": "/subnetworks/other"}]},
            "other address": {"networkInterfaces": [{**nic, "networkIP": "10.73.8.3"}]},
            "no account": {"serviceAccounts": []},
            "other account": {"serviceAccounts": [{"email": "other-vm@test-carbon.iam.gserviceaccount.com", "scopes": ["https://www.googleapis.com/auth/cloud-platform"]}]},
            "extra scope": {"serviceAccounts": [{"email": ACCOUNT, "scopes": ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email"]}]},
            "deleted disk": {"disks": [{"deviceName": "carbon-data", "autoDelete": True, "source": "/disks/carbon-data"}]},
        }
        for label, changes in variants.items():
            with self.subTest(label), patch.object(cloud, "get", return_value={**private_vm(config), **changes}), self.assertRaises(ValueError):
                cloud.check_vm()


class SourceTests(unittest.TestCase):
    def test_feature_branch_cannot_deploy(self):
        with patch.object(deploy, "run", return_value="feature/example\n"), patch.object(deploy, "Cloud") as cloud:
            with self.assertRaisesRegex(ValueError, "git switch saturn/main"):
                deploy.deploy(fixture())
            cloud.assert_not_called()

    def test_dirty_integration_branch_cannot_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(args, **kwargs):
                if args[-1] == "--show-current":
                    return "saturn/main\n"
                if "--git-path" in args:
                    return str(Path(directory) / args[-1])
                return " M file.py\n"
            with patch.object(deploy, "run", side_effect=git), patch.object(deploy, "publish_source") as publish:
                with self.assertRaisesRegex(ValueError, "clean committed"):
                    deploy.deploy(fixture())
                publish.assert_not_called()

    def source_check(self, *, destination=None, http_error=None):
        config = fixture()
        slug = config["SOURCE_REPO_URL"].removeprefix("https://github.com/")
        calls = []
        def git(args, **kwargs):
            calls.append(args)
            if "get-url" in args:
                return destination if destination is not None else f"git@github.com:{slug}.git\n"
            return ""
        response = MagicMock()
        response.__enter__.return_value.status = 200
        with patch.object(deploy, "run", side_effect=git), patch.object(deploy.urllib.request, "urlopen", return_value=response, side_effect=http_error) as request, patch.object(deploy.time, "sleep"):
            try:
                deploy.publish_source(config, "a" * 40)
            except ValueError as exc:
                return calls, request, str(exc)
        return calls, request, None

    def test_publishes_pinned_commit_to_integration_branch_without_force(self):
        calls, request, error = self.source_check()
        self.assertIsNone(error)
        push = next(args for args in calls if "push" in args)
        self.assertEqual(push[-4:], ["push", "--no-follow-tags", "origin", "a" * 40 + ":refs/heads/saturn/main"])
        self.assertNotIn("--force", push)
        self.assertEqual(request.call_args.args[0], fixture()["SOURCE_REPO_URL"] + "/tree/" + "a" * 40)
        self.assertIsInstance(request.call_args.args[0], str)  # Anonymous, no credential headers.

    def test_wrong_or_multiple_push_destinations_do_not_publish(self):
        for destination in ("git@github.com:other/private.git\n", "https://user:secret@github.com/test/carbon.git\n", "https://github.com/test/carbon.git\nhttps://github.com/other/carbon.git\n"):
            with self.subTest(destination=destination):
                calls, request, error = self.source_check(destination=destination)
                self.assertIn("origin must", error)
                self.assertFalse(any("push" in args for args in calls))
                request.assert_not_called()

    def test_source_errors_report_status_without_provider_body(self):
        for status in (404, 403, 429, 503):
            with self.subTest(status=status):
                failure = urllib.error.HTTPError("https://example.com/private", status, "sensitive provider detail", {}, None)
                _, request, error = self.source_check(http_error=failure)
                self.assertIn(f"HTTP {status}", error)
                self.assertNotIn("sensitive", error)
                self.assertNotIn("example.com/private", error)
                self.assertEqual(request.call_count, 5 if status == 404 else 1)

    def test_source_connection_error_is_actionable(self):
        _, _, error = self.source_check(http_error=urllib.error.URLError("private network detail"))
        self.assertIn("check your connection", error)
        self.assertNotIn("private network detail", error)


if __name__ == "__main__":
    unittest.main()
