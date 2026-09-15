"""Verify OAuth callback destinations in the rendered production GoTrue image.

Requires Docker Compose and PyYAML. Uses only isolated synthetic containers,
loopback HTTP, and a disposable tmpfs database. Google is never contacted: the
provider callback is canceled after obtaining real GoTrue OAuth state.

Run explicitly: python3 -m unittest discover -s contrib/deploying/gcp-tailscale/auth \
-p 'test_callback_redirects.py'
"""

import http.cookiejar
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent
REPO = DEPLOY.parents[2]
sys.path.insert(0, str(DEPLOY))
spec = importlib.util.spec_from_file_location("callback_render", DEPLOY / "render.py")
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CallbackRedirectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="carbon-callback-")
        cls.addClassCleanup(cls.temporary.cleanup)
        directory = Path(cls.temporary.name)
        cls.project = "carbon-callback-" + uuid.uuid4().hex[:12]
        cls.compose_file = directory / "compose.json"
        config = {
            "ERP_HOST": "erp.example.com",
            "MES_HOST": "mes.example.com",
            "SUPABASE_HOST": "api.example.com",
            "DNS_DOMAIN": "example.com",
            "AUTH_ALLOWED_GOOGLE_DOMAIN": "example.com",
            "TAILSCALE_IP": "100.72.10.8",
            "DEPLOY_REVISION": "a" * 40,
            "GOOGLE_CLIENT_ID": "synthetic-client",
            "GOOGLE_CLIENT_SECRET": "synthetic-secret",
            "SOURCE_CODE_URL": "https://github.com/example/carbon/tree/" + "a" * 40,
        }
        stack, _ = render.render(config, REPO, directory / "rendered", directory)
        auth = stack["services"]["gotrue"]
        auth["restart"] = "no"
        auth["platform"] = "linux/amd64"
        auth["ports"] = ["127.0.0.1::9999"]
        auth["depends_on"] = {"postgres": {"condition": "service_healthy"}}
        # The production secret-loading entrypoint, image, OAuth settings and
        # rendered allowlist are retained; only the database is replaced.
        initialization = directory / "init.sql"
        initialization.write_text(
            "CREATE SCHEMA auth; ALTER ROLE supabase_auth_admin SET search_path = auth, public; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE postgres;"
        )
        initialization.chmod(0o444)
        database = {
            "image": "postgres:15-alpine",
            "networks": ["internal"],
            "environment": {
                "POSTGRES_USER": "supabase_auth_admin",
                "POSTGRES_DB": "postgres",
                "POSTGRES_PASSWORD": (directory / "secrets/postgres_password").read_text(),
            },
            "volumes": [str(initialization) + ":/docker-entrypoint-initdb.d/init.sql:ro"],
            "tmpfs": ["/var/lib/postgresql/data:size=256m,mode=0700"],
            "healthcheck": {
                "test": ["CMD", "pg_isready", "-U", "supabase_auth_admin", "-d", "postgres"],
                "interval": "1s",
                "timeout": "2s",
                "retries": 45,
            },
        }
        fixture = {
            "services": {"postgres": database, "gotrue": auth},
            "networks": {"internal": {"driver": "bridge"}},
            "secrets": {key: stack["secrets"][key] for key in auth["secrets"]},
        }
        cls.compose_file.write_text(json.dumps(fixture))
        cls.addClassCleanup(cls.compose, "down", "--volumes", "--remove-orphans")
        try:
            cls.compose("up", "--detach", "--wait", "--wait-timeout", "90", timeout=180)
        except AssertionError as error:
            raise AssertionError(cls.compose("logs", "--tail", "40", "gotrue").stdout) from error
        endpoint = cls.compose("port", "gotrue", "9999").stdout.strip()
        cls.url = "http://" + endpoint
        cls.site_url = auth["environment"]["GOTRUE_SITE_URL"]

    @classmethod
    def compose(cls, *arguments, timeout=60):
        result = subprocess.run(
            ["docker", "compose", "--project-name", cls.project, "--file", str(cls.compose_file), *arguments],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return result

    def canceled_destination(self, requested):
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            NoRedirect(),
        )

        def location(path):
            # Never follow the provider redirect or contact a requested target.
            with self.assertRaises(urllib.error.HTTPError) as caught:
                opener.open(self.url + path, timeout=10)
            response = caught.exception
            self.assertIn(response.code, (302, 303))
            try:
                return response.headers["Location"]
            finally:
                response.close()

        authorization = location(
            "/authorize?" + urllib.parse.urlencode({"provider": "google", "redirect_to": requested})
        )
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(authorization).query)["state"][0]
        destination = location(
            "/callback?"
            + urllib.parse.urlencode(
                {"state": state, "error": "access_denied", "error_description": "Synthetic cancellation"}
            )
        )
        parsed = urllib.parse.urlsplit(destination)
        error = urllib.parse.parse_qs(parsed.fragment)
        self.assertEqual(error.get("error"), ["access_denied"])
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(query.pop("error", None), ["access_denied"])
        self.assertEqual(query.pop("error_description", None), ["Synthetic cancellation"])
        return (parsed.scheme, parsed.netloc, parsed.path, query)

    def assert_destination(self, requested, expected):
        parsed = urllib.parse.urlsplit(expected)
        self.assertEqual(
            self.canceled_destination(requested),
            (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.parse_qs(parsed.query)),
        )

    def test_mes_callback_preserves_encoded_return_paths(self):
        for path in ("%2F", "%2Fx%2Fparts%2Fpart.rev", "/x/parts/part.rev"):
            with self.subTest(path=path):
                callback = "https://mes.example.com/callback?redirectTo=" + path
                self.assert_destination(callback, callback)

    def test_existing_mes_bare_callback_and_erp_return_paths_remain_allowed(self):
        for callback in (
            "https://mes.example.com/callback",
            "https://mes.example.com",
            "https://erp.example.com/callback?redirectTo=%2F",
        ):
            with self.subTest(callback=callback):
                self.assert_destination(callback, callback)

    def test_untrusted_or_unrelated_mes_destinations_fall_back_to_erp(self):
        for callback in (
            "https://evil.example.org/callback?redirectTo=%2F",
            "https://mes.example.com.evil.example.org/callback?redirectTo=%2F",
            "https://mes.example.com@evil.example.org/callback?redirectTo=%2F",
            "http://mes.example.com/callback?redirectTo=%2F",
            "https://mes.example.com:444/callback?redirectTo=%2F",
            "https://mes.example.com/other?redirectTo=%2F",
            "https://mes.example.com/callbackXredirectTo=%2F",
            "https://mes.example.com/callback?next=%2F",
        ):
            with self.subTest(callback=callback):
                self.assert_destination(callback, self.site_url)


if __name__ == "__main__":
    unittest.main()
