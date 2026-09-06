"""Security and upgrade invariants for the rendered deployment, without a DB."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
spec = importlib.util.spec_from_file_location("carbon_render", HERE / "render.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateStackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.output = self.state / "prepared"
        self.config = {
            "ERP_HOST": "erp.example.com", "MES_HOST": "mes.example.com",
            "SUPABASE_HOST": "api.example.com", "DNS_DOMAIN": "example.com",
            "AUTH_ALLOWED_GOOGLE_DOMAIN": "example.com", "TAILSCALE_IP": "100.72.10.8",
            "DEPLOY_REVISION": "a" * 40, "GOOGLE_CLIENT_ID": "unit-test-client",
            "GOOGLE_CLIENT_SECRET": "unit-test-secret-not-a-real-credential",
            "SOURCE_CODE_URL": "https://github.com/example/carbon/tree/" + "a" * 40,
        }
        module.render(self.config, REPO, self.output, self.state)
        self.stack = json.loads((self.output / "compose.json").read_text())

    def test_only_tailnet_https_is_published(self):
        published = [(name, svc["ports"]) for name, svc in self.stack["services"].items() if "ports" in svc]
        self.assertEqual(published, [("caddy", [{"target": 443, "published": "443", "host_ip": "100.72.10.8", "protocol": "tcp"}])])
        self.assertEqual(self.stack["networks"]["internal"]["driver"], "bridge")
        self.assertNotIn("network_mode", self.stack["services"]["caddy"])

    def test_public_addresses_and_config_injection_are_rejected(self):
        for ip in ("0.0.0.0", "127.0.0.1", "192.168.1.2", "::", "100.128.0.1"):
            with self.subTest(ip=ip), self.assertRaises(ValueError):
                module.render({**self.config, "TAILSCALE_IP": ip}, REPO, self.output, self.state)
        with self.assertRaises(ValueError):
            module.render({**self.config, "ERP_HOST": "erp.example.com { respond 200 }"}, REPO, self.output, self.state)

    def test_no_database_admin_api_is_routed(self):
        self.assertNotIn("studio", self.stack["services"])
        self.assertNotIn("meta", self.stack["services"])
        gateway = yaml.safe_load((self.output / "kong.yml").read_text())
        self.assertFalse(any(service["name"] == "meta" for service in gateway["services"]))

    def test_google_policy_and_bootstrap_isolation(self):
        auth = self.stack["services"]["gotrue"]
        self.assertEqual(auth["environment"]["GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"], "true")
        self.assertEqual(auth["environment"]["GOTRUE_EXTERNAL_EMAIL_ENABLED"], "false")
        bootstrap = self.stack["services"]["gotrue-bootstrap"]
        self.assertEqual(bootstrap["profiles"], ["bootstrap"])
        self.assertEqual(bootstrap["environment"]["GOTRUE_EXTERNAL_GOOGLE_ENABLED"], "false")
        self.assertNotIn("ports", bootstrap)
        for app in ("erp", "mes"):
            self.assertEqual(self.stack["services"][app]["environment"]["AUTH_PROVIDERS"], "google")

    def test_session_cookie_is_scoped_to_the_app_parent_not_the_email_domain(self):
        config = {
            **self.config,
            "ERP_HOST": "erp.hq.example.com", "MES_HOST": "mes.hq.example.com",
            "AUTH_ALLOWED_GOOGLE_DOMAIN": "mail.example.net",
        }
        module.render(config, REPO, self.output, self.state)
        stack = json.loads((self.output / "compose.json").read_text())
        for app in ("erp", "mes"):
            self.assertEqual(stack["services"][app]["environment"]["DOMAIN"], "hq.example.com")

    def test_persistent_secrets_and_no_secret_values_in_compose(self):
        before = {path.name: path.read_bytes() for path in (self.state / "secrets").iterdir()}
        module.render(self.config, REPO, self.output, self.state)
        after = {path.name: path.read_bytes() for path in (self.state / "secrets").iterdir()}
        self.assertEqual(before, after)
        self.assertNotIn(self.config["GOOGLE_CLIENT_SECRET"], json.dumps(self.stack))
        self.assertEqual((self.state / "secrets").stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.output / "compose.json").stat().st_mode & 0o777, 0o600)

    def test_missing_persistent_key_cannot_silently_rotate_database_credentials(self):
        (self.state / "secrets/postgres_password").unlink()
        with self.assertRaisesRegex(ValueError, "Incomplete persistent secret set"):
            module.render(self.config, REPO, self.output, self.state)

    def test_operator_credentials_rotate_without_rotating_database_keys(self):
        original = (self.state / "secrets/jwt_secret").read_bytes()
        module.render({**self.config, "GOOGLE_CLIENT_SECRET": "replacement-test-secret"}, REPO, self.output, self.state)
        self.assertEqual((self.state / "secrets/google_client_secret").read_text(), "replacement-test-secret")
        self.assertEqual((self.state / "secrets/jwt_secret").read_bytes(), original)
        self.assertNotIn("replacement-test-secret", (self.output / "compose.json").read_text())

    def test_background_jobs_and_thumbnails_remain_local(self):
        for name in ("erp", "mes", "edge-runtime"):
            env = self.stack["services"][name]["environment"]
            self.assertEqual(env["INNGEST_BASE_URL"], "http://inngest:8288/")
            self.assertEqual(env["BROWSERLESS_WS_URL"], "ws://chrome:3000")
        self.assertNotIn("http://mes:3000/api/inngest", self.stack["services"]["inngest"]["command"])
        self.assertTrue(self.stack["services"]["edge-runtime"]["volumes"][-1]["source"].endswith("gcp-tailscale/auth/edge-main"))

    def test_operations_use_unstripped_image_and_private_gateway(self):
        ops = self.stack["services"]["ops"]
        self.assertEqual(ops["image"], "carbon/ops:" + "a" * 40)
        self.assertEqual(ops["environment"]["SUPABASE_URL"], "http://kong:8000")
        self.assertEqual(ops["profiles"], ["ops"])
        for app in ("erp", "mes"):
            self.assertEqual(self.stack["services"][app]["environment"]["SOURCE_CODE_URL"], self.config["SOURCE_CODE_URL"])

    def test_compose_schema(self):
        subprocess.run(["docker", "compose", "--file", str(self.output / "compose.json"), "config", "--quiet"], check=True)


if __name__ == "__main__":
    unittest.main()
