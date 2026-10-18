"""Security and upgrade invariants for the rendered deployment, without a DB."""

import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

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

    def test_erp_health_probe_sends_configured_host_and_checks_dependency_health(self):
        self.check_application_health_probe("erp", "healthy")

    def test_mes_health_probe_sends_configured_host_and_checks_liveness(self):
        self.check_application_health_probe("mes", "ok")

    def check_application_health_probe(self, service, healthy_status):
        responses = [(200, json.dumps({"status": healthy_status}), 0),
                     (200, '{"status":"degraded"}', 1),
                     (500, '{"status":"healthy"}', 1),
                     (302, '{"status":"healthy"}', 1),
                     (200, 'not json', 1),
                     (200, 'x' * 4097, 1)]
        requests = []

        class HealthHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get("Host")))
                status, body = self.server.probe_response
                self.send_response(status)
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, format, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for status, body, expected in responses:
                    with self.subTest(status=status, body=body):
                        server.probe_response = (status, body)
                        result = subprocess.run(
                            self.stack["services"][service]["healthcheck"]["test"][1:],
                            env={**os.environ, service.upper() + "_URL": f"https://{service}.example.com",
                                 "PORT": str(server.server_port)},
                            capture_output=True, text=True, timeout=10,
                        )
                        self.assertEqual(result.returncode, expected, result.stderr)
            finally:
                server.shutdown()
                thread.join()
        self.assertEqual(requests, [("/health", f"{service}.example.com")] * len(responses))

    def test_inngest_discovers_and_calls_the_canonical_private_erp_origin(self):
        for app in ("erp", "mes"):
            self.assertEqual(self.stack["services"][app]["environment"]["INNGEST_SERVE_HOST"],
                             "https://erp.example.com")
        command = self.stack["services"]["inngest"]["command"]
        self.assertEqual(command[command.index("--sdk-url") + 1],
                         "https://erp.example.com/api/inngest")

    def test_preview_matches_real_render_without_writes_or_secret_generation(self):
        config = {**self.config, "POSTGRES_PRIVATE_IP": "10.73.0.2", "POSTGRES_CLIENT_CIDRS": ["10.81.0.0/26"],
                  "PAYMENT_SYNC_COMPANY_ID": "synthetic-company", "MERCURY_API_TOKEN": "synthetic-token"}
        module.render(config, REPO, self.output, self.state)
        expected = json.loads((self.output / "compose.json").read_text())
        before = {str(path.relative_to(self.state)): path.read_bytes()
                  for path in self.state.rglob("*") if path.is_file()}
        with patch.object(module, "write_private", side_effect=AssertionError("preview wrote a file")), \
             patch.object(module, "initialize_secrets", side_effect=AssertionError("preview initialized secrets")), \
             patch.object(module.private_postgres, "certificates", side_effect=AssertionError("preview issued certificates")):
            stack, files = module.render(config, REPO, self.output, self.state, materialize=False)
        self.assertEqual(stack, expected)
        self.assertEqual(files[str(self.output.resolve() / "Caddyfile")], (self.output / "Caddyfile").read_text())
        self.assertEqual(before, {str(path.relative_to(self.state)): path.read_bytes()
                                 for path in self.state.rglob("*") if path.is_file()})

    def test_invoice_inference_is_server_only_and_preserves_private_ingress(self):
        config = {**self.config, "PROJECT_ID": "example-project", "INVOICE_INTAKE_ENABLED": "true",
                  "INVOICE_AI_PROJECT": "example-project", "INVOICE_AI_LOCATION": "us",
                  "INVOICE_AI_PRICE_VERIFIED_AT": "2026-09-06",
                  "INVOICE_AI_INPUT_PRICE_USD_PER_MILLION": "1.65", "INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION": "9.90"}
        module.render(config, REPO, self.output, self.state)
        stack = json.loads((self.output / "compose.json").read_text())
        self.assertEqual(stack["services"]["erp"]["environment"]["INVOICE_AI_LOCATION"], "us")
        for name, service in stack["services"].items():
            if name != "erp":
                self.assertNotIn("INVOICE_AI_PROJECT", service.get("environment", {}))
        self.assertEqual([name for name, service in stack["services"].items() if "ports" in service], ["caddy"])

    def test_portal_receiver_inputs_change_only_the_erp_service(self):
        registry = json.dumps({"version": 1, "receiver": {"id": "carbon-erp", "audience": "https://erp.example.com"}, "callers": [{"callerId": "portal-query", "serviceAccountSubject": "synthetic-subject-1", "sourceIapAudience": "/projects/0/global/backendServices/0", "operations": ["portal_resolveItems"], "capabilities": ["portal.read"], "requiredAccessLevels": []}]})
        config = {**self.config, "PORTAL_RECEIVER_AUDIENCE": "https://erp.example.com", "PORTAL_TRUSTED_CALLERS_JSON": registry}
        stack, files = module.render(config, REPO, self.output, self.state, materialize=False)
        secret = str(self.state / "secrets/portal_trusted_callers_json")
        self.assertEqual(files.pop(secret), registry)
        self.assertNotIn("synthetic-subject-1", json.dumps(stack))
        erp, baseline_erp = stack["services"]["erp"], self.stack["services"]["erp"]
        self.assertEqual(erp["environment"].pop("PORTAL_RECEIVER_AUDIENCE"), "https://erp.example.com")
        self.assertEqual(erp["environment"].pop("PORTAL_TRUSTED_CALLERS_JSON"), "__PORTAL_TRUSTED_CALLERS_JSON__")
        self.assertEqual(baseline_erp["environment"].pop("PORTAL_RECEIVER_AUDIENCE"), "")
        self.assertEqual(baseline_erp["environment"].pop("PORTAL_TRUSTED_CALLERS_JSON"), "")
        self.assertEqual(erp["secrets"], baseline_erp["secrets"] + ["portal_trusted_callers_json"])
        erp["secrets"] = baseline_erp["secrets"]
        self.assertEqual(stack["secrets"].pop("portal_trusted_callers_json"), {"file": secret})
        self.assertEqual(stack, self.stack)
        self.assertNotIn("PORTAL_RECEIVER_AUDIENCE", self.stack["services"]["mes"]["environment"])
        self.assertNotIn("PORTAL_TRUSTED_CALLERS_JSON", self.stack["services"]["mes"]["environment"])

    HQ = {"HQ_SIGN_IN_ENABLED": "true", "HQ_ISSUER": "https://hq.example.com",
          "HQ_OIDC_CARBON_SECRET": "synthetic-hq-client-secret-" + "x" * 16}

    def test_hq_sign_in_is_off_by_default_and_staged_inputs_change_nothing(self):
        for app in ("erp", "mes"):
            self.assertEqual(self.stack["services"][app]["environment"]["AUTH_PROVIDERS"], "google")
        for name in ("gotrue", "gotrue-bootstrap"):
            self.assertFalse([key for key in self.stack["services"][name]["environment"] if "KEYCLOAK" in key])
        self.assertNotIn("hq_oidc_carbon_secret", self.stack["secrets"])
        staged = {**self.config, **self.HQ, "HQ_SIGN_IN_ENABLED": "false"}
        stack, files = module.render(staged, REPO, self.output, self.state, materialize=False)
        self.assertEqual(stack, self.stack)
        self.assertNotIn(self.HQ["HQ_OIDC_CARBON_SECRET"], json.dumps(files))

    def test_hq_sign_in_keeps_google_as_break_glass_and_changes_only_auth(self):
        stack, files = module.render({**self.config, **self.HQ}, REPO, self.output, self.state, materialize=False)
        secret = str(self.state / "secrets/hq_oidc_carbon_secret")
        self.assertEqual(files.pop(secret), self.HQ["HQ_OIDC_CARBON_SECRET"])
        self.assertNotIn(self.HQ["HQ_OIDC_CARBON_SECRET"], json.dumps(stack))
        auth, baseline_auth = stack["services"]["gotrue"], self.stack["services"]["gotrue"]
        self.assertEqual({key: auth["environment"].pop(key) for key in list(auth["environment"]) if "KEYCLOAK" in key}, {
            "GOTRUE_EXTERNAL_KEYCLOAK_ENABLED": "true",
            "GOTRUE_EXTERNAL_KEYCLOAK_CLIENT_ID": "carbon",
            "GOTRUE_EXTERNAL_KEYCLOAK_SECRET": "__HQ_OIDC_CARBON_SECRET__",
            "GOTRUE_EXTERNAL_KEYCLOAK_URL": "https://hq.example.com/oidc/keycloak",
            "GOTRUE_EXTERNAL_KEYCLOAK_REDIRECT_URI": "https://api.example.com/auth/v1/callback",
        })
        self.assertEqual(auth["environment"]["GOTRUE_EXTERNAL_GOOGLE_ENABLED"], "true")
        self.assertEqual(auth["secrets"], baseline_auth["secrets"] + ["hq_oidc_carbon_secret"])
        auth["secrets"] = baseline_auth["secrets"]
        self.assertEqual(stack["secrets"].pop("hq_oidc_carbon_secret"), {"file": secret})
        for app in ("erp", "mes"):
            self.assertEqual(stack["services"][app]["environment"].pop("AUTH_PROVIDERS"), "hq,google")
            self.stack["services"][app]["environment"].pop("AUTH_PROVIDERS")
        # Bootstrap, the apps and every other service are otherwise byte-identical.
        self.assertEqual(stack, self.stack)

    def test_hq_cutover_disables_google_but_keeps_its_credentials_for_break_glass(self):
        config = {**self.config, **self.HQ, "GOOGLE_SIGN_IN_ENABLED": "false"}
        module.render(config, REPO, self.output, self.state)
        stack = json.loads((self.output / "compose.json").read_text())
        auth = stack["services"]["gotrue"]
        self.assertEqual(auth["environment"]["GOTRUE_EXTERNAL_GOOGLE_ENABLED"], "false")
        self.assertEqual(auth["environment"]["GOTRUE_EXTERNAL_KEYCLOAK_ENABLED"], "true")
        self.assertIn("google_client_secret", auth["secrets"])
        for app in ("erp", "mes"):
            self.assertEqual(stack["services"][app]["environment"]["AUTH_PROVIDERS"], "hq")
            self.assertNotIn("hq_oidc_carbon_secret", stack["services"][app].get("secrets", []))
        bootstrap = stack["services"]["gotrue-bootstrap"]
        self.assertEqual(bootstrap["environment"]["GOTRUE_EXTERNAL_GOOGLE_ENABLED"], "false")
        self.assertFalse([key for key in bootstrap["environment"] if "KEYCLOAK" in key])
        self.assertNotIn("hq_oidc_carbon_secret", bootstrap["secrets"])
        self.assertEqual([name for name, service in stack["services"].items() if "hq_oidc_carbon_secret" in service.get("secrets", [])], ["gotrue"])
        path = self.state / "secrets/hq_oidc_carbon_secret"
        self.assertEqual(path.read_text(), self.HQ["HQ_OIDC_CARBON_SECRET"])
        self.assertEqual(path.stat().st_mode & 0o777, 0o444)
        self.assertNotIn(self.HQ["HQ_OIDC_CARBON_SECRET"], (self.output / "compose.json").read_text())
        subprocess.run(["docker", "compose", "--file", str(self.output / "compose.json"), "config", "--quiet"], check=True)

    def test_hq_sign_in_inputs_fail_closed_without_echoing_the_secret(self):
        cases = [
            {"HQ_SIGN_IN_ENABLED": "1"}, {"HQ_SIGN_IN_ENABLED": True}, {"GOOGLE_SIGN_IN_ENABLED": "no"},
            {"HQ_ISSUER": ""}, {"HQ_ISSUER": "http://hq.example.com"}, {"HQ_ISSUER": "https://hq.example.com/"},
            {"HQ_ISSUER": "https://hq.example.com/oidc/keycloak"}, {"HQ_ISSUER": "https://HQ.example.com"},
            {"HQ_ISSUER": "https://hq.example.com:8443"}, {"HQ_ISSUER": "https://user@hq.example.com"},
            {"HQ_OIDC_CARBON_SECRET": ""}, {"HQ_OIDC_CARBON_SECRET": "too-short-synthetic-secret"},
            {"HQ_OIDC_CARBON_SECRET": "replace-with-the-hq-oidc-client-secret-or-remove-this-key"},
            {"HQ_OIDC_CARBON_SECRET": "synthetic secret with spaces and enough length"},
            {"HQ_OIDC_CARBON_SECRET": "synthetic-hq-client-secret\n" + "x" * 32},
            {"HQ_SIGN_IN_ENABLED": "false", "GOOGLE_SIGN_IN_ENABLED": "false"},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                with patch.object(module, "initialize_secrets") as initialize:
                    with self.assertRaises(ValueError) as raised:
                        module.render({**self.config, **self.HQ, **changes}, REPO, self.output, self.state)
                    initialize.assert_not_called()
                self.assertNotIn("synthetic-hq-client-secret", str(raised.exception))

    def test_only_tailnet_https_is_published(self):
        published = [(name, svc["ports"]) for name, svc in self.stack["services"].items() if "ports" in svc]
        self.assertEqual(published, [("caddy", [{"target": 443, "published": "443", "host_ip": "100.72.10.8", "protocol": "tcp"}])])
        self.assertEqual(self.stack["networks"]["internal"]["driver"], "bridge")
        self.assertNotIn("network_mode", self.stack["services"]["caddy"])

    def test_each_application_keeps_its_own_config_digest(self):
        config = {**self.config, "RELEASE_PLAN": {"services": {
            "erp": {"config_digest": "sha256:" + "1" * 64},
            "mes": {"config_digest": "sha256:" + "2" * 64},
        }}}
        module.render(config, REPO, self.output, self.state)
        stack = json.loads((self.output / "compose.json").read_text())
        self.assertEqual(stack["services"]["erp"]["labels"]["com.carbon.release.config-digest"], "sha256:" + "1" * 64)
        self.assertEqual(stack["services"]["mes"]["labels"]["com.carbon.release.config-digest"], "sha256:" + "2" * 64)

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

    def test_mes_callback_query_is_allowlisted_without_a_host_or_path_wildcard(self):
        allowed = self.stack["services"]["gotrue"]["environment"]["GOTRUE_URI_ALLOW_LIST"].split(",")
        self.assertEqual(
            allowed,
            [
                "https://erp.example.com",
                "https://erp.example.com/callback",
                "https://mes.example.com",
                "https://mes.example.com/callback",
                "https://mes.example.com/callback[?]redirectTo=**",
            ],
        )

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

    def test_unaffected_service_keeps_its_own_immutable_source_and_config_identity(self):
        previous = "b" * 40
        config = {
            **self.config,
            "RELEASE_PLAN": {"services": {
                "erp": {"source_commit": "a" * 40, "source_code_url": self.config["SOURCE_CODE_URL"], "image_digest": "sha256:abcdef", "config_mount_path": "/var/lib/carbon/config/abcdef.json"},
                "mes": {"source_commit": previous, "source_code_url": "https://github.com/example/carbon/tree/" + previous, "image_digest": "sha256:123456", "config_mount_path": "/var/lib/carbon/config/123456.json"},
            }},
        }
        module.render(config, REPO, self.output, self.state)
        stack = json.loads((self.output / "compose.json").read_text())
        self.assertEqual(stack["services"]["mes"]["image"], "carbon/mes:" + previous)
        self.assertEqual(stack["services"]["mes"]["environment"]["SOURCE_CODE_URL"], "https://github.com/example/carbon/tree/" + previous)
        self.assertEqual(stack["services"]["mes"]["labels"]["com.carbon.release.config-mount"], "/var/lib/carbon/config/123456.json")

    def test_compose_schema(self):
        subprocess.run(["docker", "compose", "--file", str(self.output / "compose.json"), "config", "--quiet"], check=True)

    def test_optional_postgres_listener_uses_verified_private_tls(self):
        config = {**self.config, "POSTGRES_PRIVATE_IP": "10.73.0.2", "POSTGRES_CLIENT_CIDRS": ["10.81.0.0/26"]}
        module.render(config, REPO, self.output, self.state)
        stack = json.loads((self.output / "compose.json").read_text())
        pg = stack["services"]["postgres"]
        self.assertEqual(pg["ports"], [{"target": 5432, "published": "5432", "host_ip": "10.73.0.2", "protocol": "tcp"}])
        self.assertIn("ssl=on", pg["command"])
        self.assertIn("ssl_min_protocol_version=TLSv1.2", pg["command"])
        self.assertIn("config_file=/etc/postgresql/postgresql.conf", pg["command"])
        self.assertEqual(pg["entrypoint"], ["/usr/local/bin/carbon-secrets-entrypoint.sh"])
        script = (self.output / "private-postgres-entrypoint.sh").read_text()
        self.assertIn("hostnossl all all 10.81.0.0/26 reject", script)
        self.assertIn("hostssl postgres all 10.81.0.0/26 scram-sha-256", script)
        self.assertIn("host all all 10.81.0.0/26 reject", script)
        self.assertIn("host replication all 10.81.0.0/26 reject", script)
        self.assertIn("cat /etc/postgresql/pg_hba.conf >>", script)
        self.assertIn("install -m 600 -o postgres -g postgres", script)
        self.assertTrue(pg["tmpfs"][0].startswith("/run/carbon-private-postgres:"))
        mounted = [item.get("source", "") for item in pg["volumes"] if isinstance(item, dict)]
        self.assertIn(str(self.state / "private-postgres/server.key"), mounted)
        self.assertFalse(any("ca.key" in item for item in mounted))
        tls = self.state / "private-postgres"
        self.assertEqual(tls.stat().st_mode & 0o777, 0o700)
        before = {path.name: path.read_bytes() for path in tls.iterdir()}
        for path in tls.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        subprocess.run(["openssl", "verify", "-CAfile", str(tls / "ca.crt"), "-verify_ip", "10.73.0.2", str(tls / "server.crt")], check=True, capture_output=True)
        module.render(config, REPO, self.output, self.state)
        self.assertEqual(before, {path.name: path.read_bytes() for path in tls.iterdir()})
        subprocess.run(["docker", "compose", "--file", str(self.output / "compose.json"), "config", "--quiet"], check=True)
        with self.assertRaisesRegex(ValueError, "differs from"):
            module.render({**config, "POSTGRES_PRIVATE_IP": "10.73.0.3"}, REPO, self.output, self.state)
        (tls / "ca.key").unlink()
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            module.render(config, REPO, self.output, self.state)

    def test_invalid_private_database_network_is_rejected_before_generating_state(self):
        with patch.object(module.private_postgres, "certificates") as certificates:
            with self.assertRaises(ValueError):
                module.render({**self.config, "POSTGRES_PRIVATE_IP": "0.0.0.0", "POSTGRES_CLIENT_CIDRS": ["0.0.0.0/0"]}, REPO, self.output, self.state)
            certificates.assert_not_called()


if __name__ == "__main__":
    unittest.main()
