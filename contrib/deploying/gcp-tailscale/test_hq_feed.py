"""HQ feed exporter: payload contract, no-money guard, token, transport and host wiring.

The database tests use a disposable cluster with a synthetic subset of Carbon's
schema: local PostgreSQL binaries, or CARBON_ISOLATION_TEST_IMAGE naming a local
PostgreSQL Docker image. Neither mode connects to an existing database.
"""

import base64
import copy
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import shutil
from string import Template
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

import hq_feed
import prepare_release
import release_plan
from deploy import validate as deploy_validate
from render import render
from test_deploy import fixture, SECRETS
from test_prepare_release import BASES, CONFIG as RELEASE_CONFIG, materialize, observation

HERE = Path(__file__).resolve().parent
KEY = "synthetic-hq-ingest-key-" + "0123456789abcdef" * 2
URL = "https://hq.example.com/ingest/carbon"
MONEY = re.compile(r"price|cost|rate|total|currency|tax|amount", re.I)


def snapshot():
    """What the query returns, including columns the projection must drop."""
    return {
        "snapshot_time": "2026-10-18T14:00:00Z",
        "email_mismatches": 0,
        "companies": [{"id": "c1", "name": "Example Works", "baseCurrencyCode": "USD"}],
        "entitlements": [
            {"email": "Ada@Example.com", "scope": "c1", "permissions": ["sales_view", "production_view"]},
            {"email": "someone@other.example", "scope": "c1", "permissions": ["sales_view"]},
        ],
        "sales_orders": [{"id": "so1", "scope": "c1", "readable_id": "SO-1", "status": "Confirmed",
                          "customer": "Acme", "order_date": "2026-10-01", "promised_date": None,
                          "unitPrice": 12.5, "currencyCode": "USD"}],
        "purchase_orders": [{"id": "po1", "scope": "c1", "readable_id": "PO-1", "status": "To Receive",
                             "supplier": "Bolt Supply", "order_date": "2026-10-02", "due_date": "2026-10-11",
                             "exchangeRate": 1, "taxAmount": 0}],
        "jobs": [{"id": "j1", "scope": "c1", "readable_id": "J-1", "status": "In Progress",
                  "item": "PART-1.A", "due_date": "2026-10-19", "quantity": 3}],
    }


def key_paths(value, path=()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield path + (key,)
            yield from key_paths(item, path + (key,))
    elif isinstance(value, list):
        for item in value:
            yield from key_paths(item, path + ("[]",))


def assert_no_money_keys(test, payload):
    """Fails if any emitted key matches the money pattern.

    generated_at is the contract's envelope timestamp; "gene-rate-d" is the only
    exemption, and only at the top level.
    """
    for path in key_paths(payload):
        if path != ("generated_at",):
            test.assertIsNone(MONEY.search(path[-1]), "money-like key emitted: " + ".".join(path))


def decode(segment):
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))


def verify_token(test, value, body, key=KEY):
    header, claims, signature = value.split(".")
    expected = hmac.new(key.encode(), f"{header}.{claims}".encode(), hashlib.sha256).digest()
    test.assertEqual(base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)), expected)
    test.assertEqual(decode(header), {"alg": "HS256", "typ": "JWT"})
    claims = decode(claims)
    test.assertEqual(set(claims), {"iss", "aud", "iat", "exp", "jti", "body_sha256"})
    test.assertEqual((claims["iss"], claims["aud"]), ("carbon", "hq-ingest"))
    test.assertEqual(claims["exp"], claims["iat"] + 60)
    test.assertEqual(uuid.UUID(claims["jti"]).version, 4)
    test.assertRegex(claims["body_sha256"], r"^[0-9a-f]{64}$")
    test.assertEqual(claims["body_sha256"], hashlib.sha256(body).hexdigest())
    return claims


class PayloadTests(unittest.TestCase):
    def test_payload_has_exactly_the_contract_shape(self):
        payload = hq_feed.build_payload(snapshot(), "example.com")
        self.assertEqual(list(payload), ["schema", "source", "generated_at", "companies", "entitlements",
                                         "sales_orders", "purchase_orders", "jobs"])
        self.assertEqual((payload["schema"], payload["source"], payload["generated_at"]),
                         (1, "carbon", "2026-10-18T14:00:00Z"))
        self.assertEqual(payload["companies"], [{"id": "c1", "name": "Example Works"}])
        # Lower-cased, sorted, and only the configured domain.
        self.assertEqual(payload["entitlements"], [
            {"email": "ada@example.com", "scope": "c1", "permissions": ["production_view", "sales_view"]}])
        self.assertEqual(payload["sales_orders"], [{
            "id": "so1", "scope": "c1", "readable_id": "SO-1", "status": "Confirmed", "customer": "Acme",
            "order_date": "2026-10-01", "promised_date": None,
            "requires": ["sales_view", "inventory_view", "invoicing_view"]}])
        self.assertEqual(payload["purchase_orders"], [{
            "id": "po1", "scope": "c1", "readable_id": "PO-1", "status": "To Receive", "supplier": "Bolt Supply",
            "order_date": "2026-10-02", "due_date": "2026-10-11",
            "requires": ["purchasing_view", "inventory_view", "invoicing_view"]}])
        self.assertEqual(payload["jobs"], [{
            "id": "j1", "scope": "c1", "readable_id": "J-1", "status": "In Progress", "item": "PART-1.A",
            "due_date": "2026-10-19", "requires": ["production_view"]}])

    def test_no_emitted_key_looks_like_money(self):
        assert_no_money_keys(self, hq_feed.build_payload(snapshot(), "example.com"))

    def test_runtime_guard_refuses_money_keys(self):
        for payload in ({"generated_at": "x", "exchangeRate": 1}, {"jobs": [{"id": "j", "unitPrice": 1}]},
                        {"nested": {"generated_at": "not the envelope"}}):
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, "money-like"):
                hq_feed.assert_money_free(payload)

    def test_query_names_no_money_column_or_key(self):
        identifiers = re.findall(r'"([^"]+)"', hq_feed.QUERY)
        keys = re.findall(r"'([A-Za-z_]+)'", hq_feed.QUERY)
        self.assertIn("promisedDate", identifiers)
        self.assertIn("readable_id", keys)
        for name in identifiers + keys:
            self.assertIsNone(MONEY.search(name), name)

    def test_unexpected_database_values_fail_closed(self):
        for kind, field, value in (("sales_orders", "order_date", "18/10/2026"), ("jobs", "id", None),
                                   ("entitlements", "permissions", ["sales view"]), ("companies", "name", 7)):
            broken = snapshot()
            broken[kind][0][field] = value
            with self.subTest(kind=kind, field=field), self.assertRaises(hq_feed.FeedError):
                hq_feed.build_payload(broken, "example.com")
        broken = snapshot()
        del broken["jobs"]
        with self.assertRaises(hq_feed.FeedError):
            hq_feed.build_payload(broken, "example.com")

    def test_case_variant_emails_grant_nothing_rather_than_merge(self):
        raw = snapshot()
        raw["entitlements"].append({"email": "ada@example.com", "scope": "c1", "permissions": ["purchasing_view"]})
        raw["entitlements"].append({"email": "ada@example.com", "scope": "c2", "permissions": ["sales_view"]})
        with patch.object(sys, "stderr", io.StringIO()) as stderr:
            payload = hq_feed.build_payload(raw, "example.com")
        self.assertEqual(payload["entitlements"], [
            {"email": "ada@example.com", "scope": "c2", "permissions": ["sales_view"]}])
        self.assertIn("1 ambiguous", stderr.getvalue())
        self.assertNotIn("ada@", stderr.getvalue())

    def test_email_mismatches_are_counted_never_named(self):
        raw = snapshot()
        raw["email_mismatches"] = 3
        with patch.object(sys, "stderr", io.StringIO()) as stderr:
            hq_feed.build_payload(raw, "example.com")
        self.assertIn("3 employee(s)", stderr.getvalue())
        for value in (-1, True, "3", None):
            raw["email_mismatches"] = value
            with self.subTest(value=value), self.assertRaises(hq_feed.FeedError):
                hq_feed.build_payload(raw, "example.com")

    def test_identity_read_uses_only_the_confirmed_sign_in_email(self):
        self.assertEqual(set(re.findall(r'au\."([^"]+)"', hq_feed.IDENTITIES)), {"id", "email", "email_confirmed_at"})
        self.assertIn('"email_confirmed_at" IS NOT NULL', hq_feed.IDENTITIES)
        self.assertNotIn('lower(u."email"),', hq_feed.SNAPSHOT)
        # One snapshot: the admin identity read, then service_role for everything else.
        self.assertEqual(hq_feed.QUERY, hq_feed.PREAMBLE + hq_feed.IDENTITIES + hq_feed.NARROW + hq_feed.SNAPSHOT
                         + "COMMIT;\n")

    def test_oversized_body_is_never_sent(self):
        payload = hq_feed.build_payload(snapshot(), "example.com")
        payload["companies"] = [{"id": "c" + str(n), "name": "x" * 1024} for n in range(8 * 1024)]
        with self.assertRaisesRegex(hq_feed.FeedError, "limit"):
            hq_feed.encode(payload)


class TokenTests(unittest.TestCase):
    def test_token_claims_signature_and_body_hash(self):
        body = hq_feed.encode(hq_feed.build_payload(snapshot(), "example.com"))
        jti = str(uuid.uuid4())
        claims = verify_token(self, hq_feed.token(body, KEY, now=1_790_000_000, jti=jti), body)
        self.assertEqual((claims["iat"], claims["jti"]), (1_790_000_000, jti))
        with self.assertRaises(AssertionError):
            verify_token(self, hq_feed.token(body + b" ", KEY, now=1, jti=jti), body)

    def test_send_posts_the_exact_body_with_a_fresh_single_use_token(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                received.append((self.path, dict(self.headers), self.rfile.read(length)))
                status = self.server.statuses.pop(0)
                self.send_response(status)
                if status == 302:
                    self.send_header("Location", "/elsewhere")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, format, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            url = f"http://127.0.0.1:{server.server_port}/ingest/carbon"
            body = hq_feed.encode(hq_feed.build_payload(snapshot(), "example.com"))
            server.statuses = [204, 200, 302, 500]
            results = [hq_feed.send(url, body, KEY) for _ in range(4)]
            server.shutdown()
        self.assertEqual(results, [204, 200, 302, 500])
        # The redirect was not followed: exactly one request per send.
        self.assertEqual([path for path, _, _ in received], ["/ingest/carbon"] * 4)
        jtis = set()
        for _, headers, raw in received:
            self.assertEqual(raw, body)
            self.assertEqual(headers["Content-Type"], "application/json")
            self.assertTrue(headers["Authorization"].startswith("Bearer "))
            claims = verify_token(self, headers["Authorization"].removeprefix("Bearer "), raw)
            self.assertLessEqual(abs(claims["iat"] - time.time()), 5)
            jtis.add(claims["jti"])
        self.assertEqual(len(jtis), 4)


class CommandTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        (self.state / "secrets").mkdir()
        (self.state / "secrets" / hq_feed.SECRET_NAME).write_text(KEY)
        self.config = self.state / "config.json"
        self.config.write_text(json.dumps({"AUTH_ALLOWED_GOOGLE_DOMAIN": "example.com", "HQ_INGEST_URL": URL,
                                           "HQ_INGEST_CARBON_KEY": KEY}))
        patcher = patch.object(hq_feed, "STATE", self.state)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_main(self, *argv, statuses=(204,)):
        sent = []

        def send(url, body, key):
            sent.append((url, body, hq_feed.token(body, key, now=int(time.time()), jti=str(uuid.uuid4()))))
            return statuses[len(sent) - 1]

        stdout, stderr = io.BytesIO(), io.StringIO()
        text_stdout = io.TextIOWrapper(stdout, encoding="utf-8")
        with patch.object(hq_feed, "read_database", return_value=snapshot()) as database, \
             patch.object(hq_feed, "send", side_effect=send), \
             patch.object(sys, "stdout", text_stdout), patch.object(sys, "stderr", stderr):
            code = hq_feed.main(["--config", str(self.config), *argv])
            text_stdout.flush()
        return code, stdout.getvalue(), stderr.getvalue(), sent, database

    def test_dry_run_prints_the_payload_and_sends_nothing(self):
        with patch.object(hq_feed, "read_key", side_effect=AssertionError("dry run read the key")), \
             patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("dry run opened a URL")):
            code, out, err, sent, database = self.run_main("--dry-run")
        self.assertEqual(code, 0, err)
        self.assertEqual(sent, [])
        self.assertEqual(json.loads(out), hq_feed.build_payload(snapshot(), "example.com"))
        self.assertEqual(database.call_args.args[0], "example.com")
        self.assertIn("nothing sent", err)

    def test_local_dry_run_needs_no_private_configuration(self):
        self.config.unlink()
        code, out, err, sent, database = self.run_main("--dry-run", "--local-psql", "--email-domain", "example.org")
        self.assertEqual(code, 0, err)
        self.assertEqual(sent, [])
        self.assertEqual(database.call_args.args, ("example.org", hq_feed.LOCAL_PSQL))
        with patch.object(sys, "stderr", io.StringIO()), self.assertRaises(SystemExit):
            hq_feed.main(["--local-psql"])

    def test_push_succeeds_only_for_200_or_204_and_logs_counts_only(self):
        for status, expected in ((204, 0), (200, 0), (201, 1), (302, 1), (401, 1), (500, 1)):
            with self.subTest(status=status):
                code, out, err, sent, _ = self.run_main(statuses=(status,))
                self.assertEqual(code, expected)
                self.assertEqual(out, b"")
                self.assertEqual(len(sent), 1)
                url, body, bearer = sent[0]
                self.assertEqual(url, URL)
                self.assertIn(f"status={status}", err)
                self.assertIn("sales_orders=1", err)
                for private in (KEY, bearer, "Example Works", "Bolt Supply", "ada@example.com", URL):
                    self.assertNotIn(private, err)

    def test_push_requires_configuration_and_the_stored_key(self):
        (self.state / "secrets" / hq_feed.SECRET_NAME).unlink()
        code, _, err, sent, database = self.run_main()
        self.assertEqual((code, sent), (1, []))
        self.assertIn("missing from the secret store", err)
        database.assert_not_called()
        self.config.write_text(json.dumps({"AUTH_ALLOWED_GOOGLE_DOMAIN": "example.com"}))
        code, _, err, sent, _ = self.run_main()
        self.assertEqual((code, sent), (1, []))
        self.assertIn("not configured", err)

    def test_transport_failure_is_named_without_its_message(self):
        error = hq_feed.urllib.error.URLError(ConnectionRefusedError("hq.example.com refused"))
        with patch.object(hq_feed, "read_database", return_value=snapshot()), \
             patch.object(hq_feed, "send", side_effect=error), patch.object(sys, "stderr", io.StringIO()) as stderr:
            self.assertEqual(hq_feed.main(["--config", str(self.config)]), 1)
        self.assertIn("URLError(ConnectionRefusedError)", stderr.getvalue())
        self.assertNotIn("hq.example.com", stderr.getvalue())


class ConfigurationTests(unittest.TestCase):
    def test_validation_fails_closed_without_echoing_the_key(self):
        hq_feed.validate({})
        hq_feed.validate({"HQ_INGEST_URL": URL})
        hq_feed.validate({"HQ_INGEST_URL": URL, "HQ_INGEST_CARBON_KEY": KEY, "HQ_INGEST_EMAIL_DOMAIN": "example.com"})
        short = "short-synthetic-key"
        for config in ({"HQ_INGEST_URL": "http://hq.example.com/ingest/carbon"},
                       {"HQ_INGEST_URL": "https://user:pass@hq.example.com/ingest"},
                       {"HQ_INGEST_URL": URL + "?next=elsewhere"}, {"HQ_INGEST_URL": "https://hq.example.com"},
                       {"HQ_INGEST_URL": URL, "HQ_INGEST_EMAIL_DOMAIN": "Example.COM"},
                       {"HQ_INGEST_CARBON_KEY": KEY},
                       {"HQ_INGEST_URL": URL, "HQ_INGEST_CARBON_KEY": short},
                       {"HQ_INGEST_URL": URL, "HQ_INGEST_CARBON_KEY": KEY[:20] + " " + KEY[20:]},
                       {"HQ_INGEST_URL": URL, "HQ_INGEST_CARBON_KEY": "replace-with-the-key-shared-with-hq"}):
            with self.subTest(config=config), self.assertRaises(ValueError) as raised:
                hq_feed.validate(config)
            self.assertNotIn(short, str(raised.exception))
            self.assertNotIn(KEY[:20], str(raised.exception))

    def test_deploy_accepts_the_optional_keys_and_rejects_a_weak_key(self):
        config = {**fixture(), "HQ_INGEST_EMAIL_DOMAIN": "example.com", "TAILNET_ACCEPT_ROUTES": ["10.20.0.10/32"]}
        deploy_validate(config, {**SECRETS, "HQ_INGEST_CARBON_KEY": KEY})
        with self.assertRaisesRegex(ValueError, "HQ_INGEST_CARBON_KEY"):
            deploy_validate(config, {**SECRETS, "HQ_INGEST_CARBON_KEY": "too-short"})
        placeholder = json.loads((HERE / "secrets.example.json").read_text())["HQ_INGEST_CARBON_KEY"]
        with self.assertRaisesRegex(ValueError, "placeholder"):
            deploy_validate(config, {**SECRETS, "HQ_INGEST_CARBON_KEY": placeholder})

    def test_key_is_a_host_only_secret_written_and_removed_with_the_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            output = state / "rendered"
            config = {**fixture(), **SECRETS, "TAILSCALE_IP": "100.72.10.8", "DEPLOY_REVISION": "a" * 40,
                      "SOURCE_CODE_URL": "https://github.com/example/carbon/tree/" + "a" * 40,
                      "HQ_INGEST_CARBON_KEY": KEY}
            render(config, HERE.parents[2], output, state)
            path = state / "secrets" / hq_feed.SECRET_NAME
            self.assertEqual(path.read_text(), KEY)
            self.assertEqual(path.stat().st_mode & 0o777, 0o400)
            content = (output / "compose.json").read_text()
            self.assertNotIn(KEY, content)
            self.assertNotIn(hq_feed.SECRET_NAME, content)
            render({**config, "HQ_INGEST_CARBON_KEY": KEY + "rotated"}, HERE.parents[2], output, state)
            self.assertEqual(path.read_text(), KEY + "rotated")
            config.pop("HQ_INGEST_CARBON_KEY")
            render(config, HERE.parents[2], output, state)
            self.assertFalse(path.exists())

    def test_changes_reach_the_host_through_maintenance_without_raw_values(self):
        def generate(config, observed):
            with patch.object(release_plan, "materialize_repository_inputs", side_effect=materialize), \
                 patch.object(release_plan, "classify_repository_changes", return_value={}):
                return prepare_release.desired_release(config, HERE.parents[2], "c" * 40, observed, BASES)

        base = {**RELEASE_CONFIG, "HQ_INGEST_URL": URL, "HQ_INGEST_CARBON_KEY": KEY,
                "TAILNET_ACCEPT_ROUTES": ["10.20.0.10/32"]}
        observed = observation()
        first = generate(base, observed)
        self.assertNotIn(KEY, json.dumps(first))
        self.assertNotIn("hq.example.com", json.dumps(first))
        observed = copy.deepcopy(observed)
        observed["manifest"]["maintenance_fingerprint"] = first["maintenance_fingerprint"]
        observed["manifest"]["maintenance_inputs"] = first["maintenance_inputs"]
        self.assertFalse(generate(base, observed)["maintenance_required"])
        for key, value in (("HQ_INGEST_URL", "https://hq2.example.com/ingest/carbon"),
                           ("HQ_INGEST_CARBON_KEY", KEY + "rotated"), ("TAILNET_ACCEPT_ROUTES", ["10.20.0.11/32"])):
            with self.subTest(key=key):
                self.assertTrue(generate({**base, key: value}, observed)["maintenance_required"])
        for name in ("hq_feed.py", "tailnet_routes.py"):
            self.assertIn(prepare_release.HERE_REL + name, prepare_release.MAINTENANCE_PATHS)


class HostWiringTests(unittest.TestCase):
    def test_units_run_every_five_minutes_without_pulling_in_docker(self):
        script = (HERE / "host-deploy.sh").read_text()
        timer = re.search(r'\$1\.timer" <<EOF\n(.*?)\nEOF', script, re.S)[1]
        self.assertIn("OnCalendar=*:0/5", timer)
        feed = re.search(r"carbon-hq-feed\.service <<'EOF'\n(.*?)\nEOF", script, re.S)[1]
        routes = re.search(r"carbon-tailnet-routes\.service <<'EOF'\n(.*?)\nEOF", script, re.S)[1]
        for service in (feed, routes):
            self.assertIn("Type=oneshot", service)
            # A timer firing during a maintenance snapshot must not restart Docker.
            self.assertNotRegex(service, r"(Requires|Wants|BindsTo)=.*docker")
        self.assertIn("ExecStart=/usr/local/sbin/carbon-hq-feed\n", feed + "\n")
        self.assertIn("ExecStartPre=/usr/local/sbin/carbon-tailnet-routes check", feed)
        self.assertIn("ExecStart=/usr/local/sbin/carbon-tailnet-routes check /var/lib/carbon/config.json", routes)
        self.assertNotIn("docker", routes)
        finalize = re.search(r"\n  finalize\)\n(.*?)\n    ;;", script, re.S)[1]
        self.assertIn("configure_host_timers", finalize)

    def test_finalize_installs_and_removes_each_timer_independently(self):
        script = (HERE / "host-deploy.sh").read_text()
        functions = script[script.index("host_timer_enabled() {"):script.index("check_stack() {")]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            units, sbin = root / "units", root / "sbin"
            units.mkdir()
            sbin.mkdir()
            functions = functions.replace("/etc/systemd/system", str(units))
            functions = functions.replace(" /usr/local/sbin/carbon-hq-feed\n", f" {sbin}/carbon-hq-feed\n")
            config, log = root / "config.json", root / "systemctl.log"
            harness = (f"set -euo pipefail\nCONFIG='{config}'\nHERE='{HERE}'\n"
                       f"systemctl() {{ printf '%s\\n' \"$*\" >> '{log}'; }}\n{functions}\nconfigure_host_timers\n")

            def finalize(values):
                config.write_text(json.dumps(values))
                log.write_text("")
                subprocess.run(["bash", "-c", harness], check=True, capture_output=True, text=True, timeout=30)
                return {path.name for path in units.iterdir()}, log.read_text().splitlines()

            routes_only = {"TAILNET_ACCEPT_ROUTES": ["10.20.0.10/32"]}
            feed = {"HQ_INGEST_URL": URL, "HQ_INGEST_CARBON_KEY": KEY}
            installed, calls = finalize({})
            self.assertEqual(installed, set())
            self.assertNotIn("enable --now carbon-tailnet-routes.timer", calls)
            # Route verification runs even with the HQ feed off.
            installed, calls = finalize(routes_only)
            self.assertEqual(installed, {"carbon-tailnet-routes.service", "carbon-tailnet-routes.timer"})
            self.assertIn("enable --now carbon-tailnet-routes.timer", calls)
            self.assertNotIn("enable --now carbon-hq-feed.timer", calls)
            self.assertFalse((sbin / "carbon-hq-feed").exists())
            self.assertIn("OnCalendar=*:0/5", (units / "carbon-tailnet-routes.timer").read_text())
            installed, calls = finalize({**routes_only, **feed})
            self.assertEqual(installed, {"carbon-tailnet-routes.service", "carbon-tailnet-routes.timer",
                                         "carbon-hq-feed.service", "carbon-hq-feed.timer"})
            self.assertIn("enable --now carbon-hq-feed.timer", calls)
            self.assertEqual((sbin / "carbon-hq-feed").read_bytes(), (HERE / "hq_feed.py").read_bytes())
            installed, calls = finalize(feed)
            self.assertEqual(installed, {"carbon-hq-feed.service", "carbon-hq-feed.timer"})
            self.assertIn("disable --now carbon-tailnet-routes.timer", calls)
            installed, calls = finalize({"HQ_INGEST_URL": URL})
            self.assertEqual(installed, set())
            self.assertIn("disable --now carbon-hq-feed.timer", calls)
            self.assertFalse((sbin / "carbon-hq-feed").exists())

    def test_bootstrap_accepts_routes_only_through_the_allowlist_guard(self):
        script = (HERE / "bootstrap.sh").read_text()
        self.assertIn("--accept-routes=false", re.search(r"tailscale up [^\n]*", script)[0])
        unpack, guard = script.index("tar -xzf"), script.index("carbon-tailnet-routes apply")
        self.assertLess(unpack, guard)
        self.assertNotIn("--accept-routes=true", script)


class DatabaseTests(unittest.TestCase):
    """Run the exporter's real query against a synthetic subset of Carbon's schema.

    service_role may SELECT only the columns the contract needs, so the query
    fails if it reads any other column, money included.
    """

    @classmethod
    def command(cls, *args, input=None, check=True):
        result = subprocess.run(args, input=input, text=True, capture_output=True, env=cls.environment, timeout=60)
        if check and result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return result

    @classmethod
    def sql(cls, statement, *, database="feed_test", check=True):
        return cls.command(*cls.psql, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database,
                           input=statement, check=check)

    @classmethod
    def setUpClass(cls):
        cls.environment = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        cls.environment["LC_ALL"] = "C"
        image = os.environ.get("CARBON_ISOLATION_TEST_IMAGE")
        if image:
            container = "carbon-hq-feed-" + uuid.uuid4().hex[:12]
            cls.command("docker", "run", "-d", "--rm", "--network", "none", "--tmpfs", "/tmp:rw,mode=1777,size=256m",
                        "--user", "postgres", "--name", container, "--entrypoint", "/bin/sh", image, "-ceu",
                        "initdb -D /tmp/feed-data --auth-local=trust --auth-host=reject --no-locale >/tmp/init.log; "
                        "exec postgres -D /tmp/feed-data -k /tmp -c listen_addresses='' -c fsync=off")
            cls.addClassCleanup(cls.command, "docker", "rm", "-f", container, check=False)
            cls.psql = ["docker", "exec", "-i", container, "psql", "-h", "/tmp"]
        else:
            for binary in ("initdb", "pg_ctl", "psql"):
                if not shutil.which(binary):
                    raise unittest.SkipTest("Install PostgreSQL or set CARBON_ISOLATION_TEST_IMAGE")
            temporary = tempfile.TemporaryDirectory(prefix="carbon-hq-feed-", dir="/tmp")
            cls.addClassCleanup(temporary.cleanup)
            cluster = Path(temporary.name)
            cls.command("initdb", "-D", str(cluster / "data"), "-U", "postgres", "--auth-local=trust",
                        "--auth-host=reject", "--no-locale")
            cls.command("pg_ctl", "-D", str(cluster / "data"), "-l", str(cluster / "postgres.log"), "-w", "start",
                        "-o", f"-k {cluster} -c listen_addresses='' -c fsync=off")
            cls.addClassCleanup(cls.command, "pg_ctl", "-D", str(cluster / "data"), "-m", "immediate", "-w", "stop",
                                check=False)
            cls.psql = ["psql", "-h", str(cluster), "-p", "5432"]
        for _ in range(60):
            if cls.sql("SELECT 1", database="postgres", check=False).returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise AssertionError("Disposable PostgreSQL did not become ready")
        cls.sql("CREATE DATABASE feed_test", database="postgres")
        cls.sql(SCHEMA + DATA)

    def read(self, domain="example.com"):
        with patch.dict(os.environ, {"LC_ALL": "C"}, clear=False):
            for key in [k for k in os.environ if k.startswith("PG")]:
                os.environ.pop(key)
            return hq_feed.read_database(domain, (*self.psql, "-U", "postgres", "-d", "feed_test"))

    def test_snapshot_matches_the_contract_semantics(self):
        raw = self.read()
        self.assertEqual(raw["email_mismatches"], 2)
        with patch.object(sys, "stderr", io.StringIO()):
            payload = hq_feed.build_payload(raw, "example.com")
        self.assertRegex(payload["generated_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(payload["companies"], [{"id": "c1", "name": "Example Works"},
                                                {"id": "c2", "name": "Second Shop"}])
        self.assertEqual(payload["entitlements"], [
            {"email": "ada@example.com", "scope": "c1",
             "permissions": ["invoicing_update", "production_view", "sales_view"]},
            {"email": "ada@example.com", "scope": "c2", "permissions": ["production_view", "purchasing_view"]},
            {"email": "bo@example.com", "scope": "c1", "permissions": []},
        ])
        sales = ["sales_view", "inventory_view", "invoicing_view"]
        self.assertEqual(payload["sales_orders"], [
            {"id": "so1", "scope": "c1", "readable_id": "SO-1", "status": "Confirmed", "customer": "Acme Customer",
             "order_date": "2026-10-01", "promised_date": "2026-10-12", "requires": sales},
            {"id": "so6", "scope": "c1", "readable_id": "SO-6", "status": "Draft", "customer": None,
             "order_date": None, "promised_date": None, "requires": sales},
            # The customer and line belong to another company: never joined across tenants.
            {"id": "so7", "scope": "c2", "readable_id": "SO-7", "status": "To Ship", "customer": None,
             "order_date": "2026-10-03", "promised_date": None, "requires": sales},
        ])
        purchasing = ["purchasing_view", "inventory_view", "invoicing_view"]
        self.assertEqual(payload["purchase_orders"], [
            {"id": "po1", "scope": "c1", "readable_id": "PO-1", "status": "To Receive", "supplier": "Bolt Supply",
             "order_date": "2026-10-02", "due_date": "2026-10-11", "requires": purchasing},
            {"id": "po5", "scope": "c1", "readable_id": "PO-5", "status": "Draft", "supplier": None,
             "order_date": None, "due_date": None, "requires": purchasing},
        ])
        self.assertEqual([(j["id"], j["status"], j["item"], j["due_date"]) for j in payload["jobs"]], [
            ("j1", "In Progress", "PART-1.A", "2026-10-19"), ("j6", "Planned", "Unnamed widget", None),
            ("j7", "Ready", None, None), ("j8", "Draft", "PART-1.A", None), ("j9", "Paused", "PART-1.A", None),
        ])
        self.assertTrue(all(j["requires"] == ["production_view"] for j in payload["jobs"]))
        assert_no_money_keys(self, payload)

    def test_read_is_one_read_only_repeatable_read_transaction_as_service_role(self):
        probe = hq_feed.PREAMBLE + hq_feed.NARROW + ("SELECT current_setting('transaction_isolation'), "
                                    "current_setting('transaction_read_only'), current_user;\nCOMMIT;\n")
        self.assertEqual(self.sql(probe).stdout.strip(), "repeatable read|on|service_role")
        self.assertEqual(hq_feed.QUERY.count("BEGIN"), 1)
        self.assertTrue(hq_feed.QUERY.startswith(hq_feed.PREAMBLE))
        write = self.sql(hq_feed.PREAMBLE + hq_feed.NARROW + "DELETE FROM public.\"job\";\nCOMMIT;\n", check=False)
        self.assertNotEqual(write.returncode, 0)
        self.assertIn("read-only transaction", write.stderr)

    def test_reading_a_money_column_would_fail_this_harness(self):
        result = self.sql(hq_feed.PREAMBLE + hq_feed.NARROW + 'SELECT "unitPrice" FROM public."salesOrderLine";\n'
                          "COMMIT;\n", check=False)
        self.assertIn("permission denied", result.stderr)

    def test_service_role_cannot_read_sign_in_identities(self):
        # As in the production image: hence the admin's two-column identity read.
        result = self.sql(hq_feed.PREAMBLE + hq_feed.NARROW + 'SELECT "email" FROM auth."users";\nCOMMIT;\n',
                          check=False)
        self.assertIn("permission denied", result.stderr)

    def test_edited_profile_email_cannot_claim_or_disturb_another_identity(self):
        with patch.object(sys, "stderr", io.StringIO()) as stderr:
            payload = hq_feed.build_payload(self.read(), "example.com")
        # u8 set its profile email to Ada's address and u9 to an address with no
        # Carbon account. Neither gains anything, and Ada keeps exactly her own.
        self.assertEqual({row["email"] for row in payload["entitlements"]}, {"ada@example.com", "bo@example.com"})
        ada = [row for row in payload["entitlements"] if row["email"] == "ada@example.com" and row["scope"] == "c1"]
        self.assertEqual(ada[0]["permissions"], ["invoicing_update", "production_view", "sales_view"])
        self.assertIn("2 employee(s)", stderr.getvalue())
        for private in ("mallory", "trent", "nobody", "ada@"):
            self.assertNotIn(private, stderr.getvalue())

    def test_unconfirmed_sign_in_email_grants_nothing_until_confirmed(self):
        def emails():
            with patch.object(sys, "stderr", io.StringIO()):
                return {row["email"] for row in hq_feed.build_payload(self.read(), "example.com")["entitlements"]}

        self.assertNotIn("una@example.com", emails())
        self.sql(f"UPDATE auth.\"users\" SET \"email_confirmed_at\" = now() WHERE \"id\" = '{USERS['u10']}'")
        try:
            self.assertIn("una@example.com", emails())
        finally:
            self.sql(f"UPDATE auth.\"users\" SET \"email_confirmed_at\" = NULL WHERE \"id\" = '{USERS['u10']}'")
        self.assertNotIn("noa@example.com", emails())

    def test_unknown_domain_exports_no_entitlements(self):
        with patch.object(sys, "stderr", io.StringIO()):
            self.assertEqual(hq_feed.build_payload(self.read("example.net"), "example.net")["entitlements"], [])


# Carbon user ids are GoTrue auth.users ids.
USERS = {f"u{n}": f"00000000-0000-4000-8000-{n:012d}" for n in range(1, 12)}

SCHEMA = """
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO service_role;
-- As in the production image: schema usage, but no SELECT on auth.users.
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO service_role;
CREATE TABLE auth."users" ("id" UUID PRIMARY KEY, "email" VARCHAR(255), "email_confirmed_at" TIMESTAMPTZ,
  "encrypted_password" VARCHAR(255), "raw_user_meta_data" JSONB);
CREATE TYPE "role" AS ENUM ('customer', 'employee', 'supplier');
CREATE TYPE "salesOrderStatus" AS ENUM ('Draft', 'Needs Approval', 'Confirmed', 'In Progress', 'Completed',
  'Invoiced', 'Cancelled', 'Closed', 'To Ship and Invoice', 'To Ship', 'To Invoice');
CREATE TYPE "purchaseOrderStatus" AS ENUM ('Draft', 'To Review', 'Rejected', 'To Receive', 'To Receive and Invoice',
  'To Invoice', 'Completed', 'Closed', 'Planned', 'Needs Approval');
CREATE TYPE "jobStatus" AS ENUM ('Draft', 'Ready', 'In Progress', 'Paused', 'Completed', 'Cancelled', 'Overdue',
  'Due Today', 'Planned', 'Closed');
CREATE TABLE "company" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "baseCurrencyCode" TEXT, "taxId" TEXT);
CREATE TABLE "user" ("id" TEXT PRIMARY KEY, "email" TEXT NOT NULL, "firstName" TEXT, "active" BOOLEAN DEFAULT TRUE);
CREATE UNIQUE INDEX "index_user_email_key" ON "user"("email");
CREATE TABLE "userToCompany" ("userId" TEXT, "companyId" TEXT, "role" "role");
CREATE TABLE "employee" ("id" TEXT, "companyId" TEXT, "active" BOOLEAN DEFAULT FALSE, "pin" TEXT);
CREATE TABLE "userPermission" ("id" TEXT PRIMARY KEY, "permissions" JSONB DEFAULT '{}');
CREATE TABLE "customer" ("id" TEXT, "companyId" TEXT, "name" TEXT, "currencyCode" TEXT, "taxPercent" NUMERIC);
CREATE TABLE "supplier" ("id" TEXT, "companyId" TEXT, "name" TEXT, "currencyCode" TEXT, "taxPercent" NUMERIC);
CREATE TABLE "item" ("id" TEXT, "companyId" TEXT, "readableId" TEXT, "readableIdWithRevision" TEXT, "name" TEXT);
CREATE TABLE "salesOrder" ("id" TEXT, "companyId" TEXT, "salesOrderId" TEXT, "status" "salesOrderStatus",
  "customerId" TEXT, "orderDate" DATE, "currencyCode" TEXT, "exchangeRate" NUMERIC);
CREATE TABLE "salesOrderLine" ("id" TEXT, "companyId" TEXT, "salesOrderId" TEXT, "promisedDate" DATE,
  "unitPrice" NUMERIC, "taxPercent" NUMERIC, "addOnCost" NUMERIC);
CREATE TABLE "purchaseOrder" ("id" TEXT, "companyId" TEXT, "purchaseOrderId" TEXT, "status" "purchaseOrderStatus",
  "supplierId" TEXT, "orderDate" DATE, "currencyCode" TEXT, "exchangeRate" NUMERIC);
CREATE TABLE "purchaseOrderLine" ("id" TEXT, "companyId" TEXT, "purchaseOrderId" TEXT, "promisedDate" DATE,
  "requiredDate" DATE, "unitPrice" NUMERIC, "taxAmount" NUMERIC, "extendedPrice" NUMERIC);
CREATE TABLE "job" ("id" TEXT, "companyId" TEXT, "jobId" TEXT, "status" "jobStatus", "itemId" TEXT,
  "dueDate" DATE, "quantity" NUMERIC);
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['company', 'user', 'userToCompany', 'employee', 'userPermission', 'customer',
    'supplier', 'item', 'salesOrder', 'salesOrderLine', 'purchaseOrder', 'purchaseOrderLine', 'job'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
GRANT SELECT ("id", "name") ON "company" TO service_role;
GRANT SELECT ("id", "email", "active") ON "user" TO service_role;
GRANT SELECT ("userId", "companyId", "role") ON "userToCompany" TO service_role;
GRANT SELECT ("id", "companyId", "active") ON "employee" TO service_role;
GRANT SELECT ("id", "permissions") ON "userPermission" TO service_role;
GRANT SELECT ("id", "companyId", "name") ON "customer", "supplier" TO service_role;
GRANT SELECT ("id", "companyId", "readableId", "readableIdWithRevision", "name") ON "item" TO service_role;
GRANT SELECT ("id", "companyId", "salesOrderId", "status", "customerId", "orderDate") ON "salesOrder" TO service_role;
GRANT SELECT ("companyId", "salesOrderId", "promisedDate") ON "salesOrderLine" TO service_role;
GRANT SELECT ("id", "companyId", "purchaseOrderId", "status", "supplierId", "orderDate")
  ON "purchaseOrder" TO service_role;
GRANT SELECT ("companyId", "purchaseOrderId", "promisedDate", "requiredDate") ON "purchaseOrderLine" TO service_role;
GRANT SELECT ("id", "companyId", "jobId", "status", "itemId", "dueDate") ON "job" TO service_role;
"""

DATA = Template("""
INSERT INTO "company" VALUES ('c1', 'Example Works', 'USD', 'T-1'), ('c2', 'Second Shop', 'EUR', 'T-2');
INSERT INTO "user" ("id", "email", "active") VALUES
  ('$u1', 'Ada@Example.com', TRUE), ('$u2', 'bo@example.com', TRUE), ('$u3', 'cy@example.com', FALSE),
  ('$u4', 'di@example.com', TRUE), ('$u5', 'ed@example.com', TRUE), ('$u6', 'fa@other.example', TRUE),
  ('$u7', 'gu@sub.example.com', TRUE),
  -- Profile emails edited by their owners: one claims Ada's address, one an address with no Carbon account.
  ('$u8', 'ada@example.com', TRUE), ('$u9', 'nobody@example.com', TRUE),
  -- An unconfirmed sign-in email, and no sign-in identity at all.
  ('$u10', 'una@example.com', TRUE), ('$u11', 'noa@example.com', TRUE);
INSERT INTO auth."users" ("id", "email", "email_confirmed_at", "encrypted_password") VALUES
  ('$u1', 'ada@example.com', now(), 'x'), ('$u2', 'BO@example.com', now(), 'x'), ('$u3', 'cy@example.com', now(), 'x'),
  ('$u4', 'di@example.com', now(), 'x'), ('$u5', 'ed@example.com', now(), 'x'), ('$u6', 'fa@other.example', now(), 'x'),
  ('$u7', 'gu@sub.example.com', now(), 'x'), ('$u8', 'mallory@example.com', now(), 'x'),
  ('$u9', 'trent@example.com', now(), 'x'), ('$u10', 'una@example.com', NULL, 'x');
INSERT INTO "userToCompany" VALUES ('$u1', 'c1', 'employee'), ('$u1', 'c2', 'employee'), ('$u2', 'c1', 'employee'),
  ('$u3', 'c1', 'employee'), ('$u4', 'c1', 'employee'), ('$u5', 'c1', 'customer'), ('$u6', 'c1', 'employee'),
  ('$u7', 'c1', 'employee'), ('$u8', 'c1', 'employee'), ('$u9', 'c1', 'employee'), ('$u10', 'c1', 'employee'),
  ('$u11', 'c1', 'employee');
INSERT INTO "employee" ("id", "companyId", "active") VALUES ('$u1', 'c1', TRUE), ('$u1', 'c2', TRUE),
  ('$u2', 'c1', TRUE), ('$u3', 'c1', TRUE), ('$u4', 'c1', FALSE), ('$u5', 'c1', TRUE), ('$u6', 'c1', TRUE),
  ('$u7', 'c1', TRUE), ('$u8', 'c1', TRUE), ('$u9', 'c1', TRUE), ('$u10', 'c1', TRUE), ('$u11', 'c1', TRUE);
INSERT INTO "userPermission" VALUES
  ('$u1', '{"sales_view": ["c1"], "production_view": ["c1", "c2"], "purchasing_view": ["c2"],
           "invoicing_update": ["c1"], "settings_view": "c1", "accounting_view": []}'),
  ('$u3', '{"sales_view": ["c1"]}'), ('$u4', '{"sales_view": ["c1"]}'), ('$u5', '{"sales_view": ["c1"]}'),
  ('$u6', '{"sales_view": ["c1"]}'), ('$u7', '{"sales_view": ["c1"]}'),
  ('$u8', '{"accounting_view": ["c1"], "sales_view": ["c1"]}'), ('$u9', '{"sales_view": ["c1"]}'),
  ('$u10', '{"production_view": ["c1"]}'), ('$u11', '{"sales_view": ["c1"]}');
INSERT INTO "customer" VALUES ('cu1', 'c1', 'Acme Customer', 'USD', 0.1);
INSERT INTO "supplier" VALUES ('su1', 'c1', 'Bolt Supply', 'USD', 0.2);
INSERT INTO "item" VALUES ('i1', 'c1', 'PART-1', 'PART-1.A', 'Bracket'), ('i2', 'c1', NULL, NULL, 'Unnamed widget');
INSERT INTO "salesOrder" VALUES
  ('so1', 'c1', 'SO-1', 'Confirmed', 'cu1', '2026-10-01', 'USD', 1), ('so2', 'c1', 'SO-2', 'Completed', 'cu1', NULL, 'USD', 1),
  ('so3', 'c1', 'SO-3', 'Invoiced', 'cu1', NULL, 'USD', 1), ('so4', 'c1', 'SO-4', 'Cancelled', 'cu1', NULL, 'USD', 1),
  ('so5', 'c1', 'SO-5', 'Closed', 'cu1', NULL, 'USD', 1), ('so6', 'c1', 'SO-6', 'Draft', NULL, NULL, 'USD', 1),
  ('so7', 'c2', 'SO-7', 'To Ship', 'cu1', '2026-10-03', 'EUR', 1.1);
INSERT INTO "salesOrderLine" VALUES ('l1', 'c1', 'so1', '2026-10-20', 10, 0.1, 0), ('l2', 'c1', 'so1', '2026-10-12', 10, 0.1, 0),
  ('l3', 'c1', 'so1', NULL, 10, 0.1, 0), ('l4', 'c1', 'so7', '2026-01-01', 10, 0.1, 0);
INSERT INTO "purchaseOrder" VALUES
  ('po1', 'c1', 'PO-1', 'To Receive', 'su1', '2026-10-02', 'USD', 1), ('po2', 'c1', 'PO-2', 'Completed', 'su1', NULL, 'USD', 1),
  ('po3', 'c1', 'PO-3', 'Closed', 'su1', NULL, 'USD', 1), ('po4', 'c1', 'PO-4', 'Rejected', 'su1', NULL, 'USD', 1),
  ('po5', 'c1', 'PO-5', 'Draft', NULL, NULL, 'USD', 1);
-- Per line, a supplier's promise supersedes the required date: 10-15, 10-11, 10-30.
INSERT INTO "purchaseOrderLine" VALUES ('pl1', 'c1', 'po1', NULL, '2026-10-15', 5, 0, 5),
  ('pl2', 'c1', 'po1', '2026-10-11', '2026-10-20', 5, 0, 5), ('pl3', 'c1', 'po1', '2026-10-30', '2026-10-01', 5, 0, 5);
INSERT INTO "job" VALUES ('j1', 'c1', 'J-1', 'In Progress', 'i1', '2026-10-19', 1), ('j2', 'c1', 'J-2', 'Completed', 'i1', NULL, 1),
  ('j3', 'c1', 'J-3', 'Cancelled', 'i1', NULL, 1), ('j4', 'c1', 'J-4', 'Closed', 'i1', NULL, 1),
  ('j5', 'c1', 'J-5', 'Overdue', 'i1', NULL, 1), ('j6', 'c1', 'J-6', 'Planned', 'i2', NULL, 1),
  ('j7', 'c1', 'J-7', 'Ready', NULL, NULL, 1), ('j8', 'c1', 'J-8', 'Draft', 'i1', NULL, 1),
  ('j9', 'c1', 'J-9', 'Paused', 'i1', NULL, 1);
""").substitute(USERS)


if __name__ == "__main__":
    unittest.main()
