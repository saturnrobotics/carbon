"""Verify OAuth flows in the rendered production GoTrue image.

Requires Docker Compose and PyYAML. Uses only isolated synthetic containers,
loopback HTTP, and a disposable tmpfs database. Google is never contacted: the
provider callback is canceled after obtaining real GoTrue OAuth state. HQ sign-in
runs against a synthetic Keycloak-compatible provider on the fixture network.

Run explicitly: python3 -m unittest discover -s contrib/deploying/gcp-tailscale/auth \
-p 'test_callback_redirects.py'
"""

import base64
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


class GoTrueStack(unittest.TestCase):
    """One rendered GoTrue with only its database (and optional peers) replaced."""

    CHANGES = {}

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
            **cls.CHANGES,
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
            "services": {"postgres": database, "gotrue": auth, **cls.peers(directory, auth)},
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
    def peers(cls, directory, auth):
        return {}

    @classmethod
    def compose(cls, *arguments, timeout=60, input=None):
        result = subprocess.run(
            ["docker", "compose", "--project-name", cls.project, "--file", str(cls.compose_file), *arguments],
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input,
        )
        if result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return result

    def setUp(self):
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            NoRedirect(),
        )

    def location(self, path):
        # Never follow the provider redirect or contact a requested target.
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.opener.open(self.url + path, timeout=10)
        response = caught.exception
        self.assertIn(response.code, (302, 303))
        try:
            return response.headers["Location"]
        finally:
            response.close()

    def authorize(self, provider, requested, **extra):
        authorization = self.location(
            "/authorize?" + urllib.parse.urlencode({"provider": provider, "redirect_to": requested, **extra})
        )
        return authorization, urllib.parse.parse_qs(urllib.parse.urlsplit(authorization).query)["state"][0]

    def canceled_destination(self, requested, provider="google"):
        _, state = self.authorize(provider, requested)
        destination = self.location(
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

    def assert_destination(self, requested, expected, provider="google"):
        parsed = urllib.parse.urlsplit(expected)
        self.assertEqual(
            self.canceled_destination(requested, provider),
            (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.parse_qs(parsed.query)),
        )


class CallbackRedirectTests(GoTrueStack):
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


HQ_SECRET = "synthetic-hq-client-secret-" + "x" * 16
LINKED_USER = "20000000-0000-0000-0000-000000000002"
# Userinfo responses of the synthetic provider, keyed by authorization code.
HQ_USERS = {
    "new-employee": {"sub": "synthetic-subject-new", "email": "new.employee@example.com", "email_verified": True,
                     "name": "New Employee", "hd": "example.com", "hq_capabilities": ["read:app"]},
    "linked-employee": {"sub": "synthetic-subject-linked", "email": "linked.employee@example.com",
                        "email_verified": True, "name": "Linked Employee", "hd": "example.com",
                        "hq_capabilities": []},
    "other-workspace": {"sub": "synthetic-subject-other", "email": "outsider@example.com", "email_verified": True,
                        "name": "Outsider", "hd": "other.example", "hq_capabilities": []},
    "unverified": {"sub": "synthetic-subject-unverified", "email": "unverified@example.com",
                   "email_verified": False, "name": "Unverified", "hd": "example.com", "hq_capabilities": []},
}
# A minimal Keycloak-compatible provider: the token and userinfo endpoints that
# GoTrue calls server to server, plus a request log for the assertions.
HQ_PROVIDER = r"""
import { createServer } from "node:http";
const base = "/oidc/keycloak/protocol/openid-connect";
const users = JSON.parse(process.env.USERS);
const requests = [];
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const url = new URL(req.url, "http://provider");
    if (url.pathname === "/_health") return send(res, 200, {});
    if (url.pathname === "/_requests") return send(res, 200, requests);
    if (req.method === "POST" && url.pathname === base + "/token") {
      const form = new URLSearchParams(body);
      const header = req.headers.authorization ?? "";
      const basic = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString() : null;
      const split = basic === null ? -1 : basic.indexOf(":");
      const id = basic === null ? form.get("client_id") : decodeURIComponent(basic.slice(0, split));
      const secret = basic === null ? form.get("client_secret") : decodeURIComponent(basic.slice(split + 1));
      const code = form.get("code");
      requests.push({ endpoint: "token", style: basic === null ? "post" : "basic", clientId: id,
                      grantType: form.get("grant_type"), redirectUri: form.get("redirect_uri"),
                      codeVerifier: form.has("code_verifier") });
      if (id !== "carbon" || secret !== process.env.CLIENT_SECRET) return send(res, 401, { error: "invalid_client" });
      if (form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== process.env.REDIRECT_URI
          || !Object.hasOwn(users, code)) return send(res, 400, { error: "invalid_grant" });
      return send(res, 200, { access_token: "synthetic-access-" + code, token_type: "Bearer", expires_in: 300 });
    }
    if (req.method === "GET" && url.pathname === base + "/userinfo") {
      const code = (req.headers.authorization ?? "").replace(/^Bearer synthetic-access-/, "");
      requests.push({ endpoint: "userinfo", code });
      return Object.hasOwn(users, code) ? send(res, 200, users[code]) : send(res, 401, { error: "invalid_token" });
    }
    return send(res, 404, { error: "not_found" });
  });
}).listen(8080, "0.0.0.0");
"""


class HqSignInTests(GoTrueStack):
    """HQ sign-in with Google kept as break-glass, through the production hook."""

    CHANGES = {"HQ_SIGN_IN_ENABLED": "true", "HQ_ISSUER": "https://hq.example.com", "HQ_OIDC_CARBON_SECRET": HQ_SECRET}
    PROVIDER = "http://hq-provider:8080/oidc/keycloak"
    CALLBACK = "https://erp.example.com/callback?redirectTo=%2F"

    @classmethod
    def peers(cls, directory, auth):
        environment = auth["environment"]
        if environment["GOTRUE_EXTERNAL_KEYCLOAK_URL"] != "https://hq.example.com/oidc/keycloak":
            raise AssertionError("The renderer did not configure HQ's Keycloak-compatible provider")
        # Only the provider origin is replaced, as the database is: TLS to HQ and
        # the tailnet route belong to the platform check, not this fixture.
        environment["GOTRUE_EXTERNAL_KEYCLOAK_URL"] = cls.PROVIDER
        auth["depends_on"]["hq-provider"] = {"condition": "service_healthy"}
        script = directory / "provider.mjs"
        script.write_text(HQ_PROVIDER)
        script.chmod(0o444)
        return {"hq-provider": {
            "image": "node:22-bookworm-slim",
            "networks": ["internal"],
            "command": ["node", "/provider/provider.mjs"],
            "volumes": [str(script) + ":/provider/provider.mjs:ro"],
            "ports": ["127.0.0.1::8080"],
            "environment": {"CLIENT_SECRET": HQ_SECRET, "USERS": json.dumps(HQ_USERS),
                            "REDIRECT_URI": environment["GOTRUE_EXTERNAL_KEYCLOAK_REDIRECT_URI"]},
            "healthcheck": {
                "test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/_health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"],
                "interval": "1s", "timeout": "2s", "retries": 45,
            },
        }}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.compose(
            "exec", "-T", "postgres", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "supabase_auth_admin",
            "-d", "postgres", "-v", "allowed_email_domain=example.com", "-f", "-",
            input=(HERE / "google-domain-hook.sql").read_text(),
        )
        cls.provider = "http://" + cls.compose("port", "hq-provider", "8080").stdout.strip()
        cls.sql(f"""
            -- As GoTrue writes a Google sign-up: token columns are empty strings.
            INSERT INTO auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                                    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                                    confirmation_token, recovery_token, email_change_token_new, email_change,
                                    email_change_token_current, reauthentication_token, phone_change, phone_change_token)
            VALUES ('00000000-0000-0000-0000-000000000000', '{LINKED_USER}', 'authenticated', 'authenticated',
                    'linked.employee@example.com', now(), '{{"provider":"google","providers":["google"]}}', '{{}}',
                    now(), now(), '', '', '', '', '', '', '', '');
            INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
            VALUES ('synthetic-google-subject', '{LINKED_USER}',
                    '{{"sub":"synthetic-google-subject","email":"linked.employee@example.com","email_verified":true,"custom_claims":{{"hd":"example.com"}}}}',
                    'google', now(), now());
        """)

    @classmethod
    def sql(cls, statement):
        return cls.compose(
            "exec", "-T", "postgres", "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
            "-U", "supabase_auth_admin", "-d", "postgres", "-f", "-", input=statement,
        ).stdout.strip()

    def provider_requests(self):
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(self.provider + "/_requests", timeout=10) as response:
            return json.load(response)

    def sign_in(self, code):
        _, state = self.authorize("keycloak", self.CALLBACK, scopes="profile email")
        before = len(self.provider_requests())
        destination = urllib.parse.urlsplit(self.location("/callback?" + urllib.parse.urlencode({"code": code, "state": state})))
        self.assertEqual((destination.scheme, destination.netloc, destination.path), ("https", "erp.example.com", "/callback"))
        return urllib.parse.parse_qs(destination.fragment), self.provider_requests()[before:]

    @staticmethod
    def claims(token):
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))

    def test_authorize_redirects_the_browser_to_hq_with_the_carbon_client(self):
        authorization, state = self.authorize("keycloak", self.CALLBACK, scopes="profile email")
        parsed = urllib.parse.urlsplit(authorization)
        self.assertEqual(parsed._replace(query="").geturl(), self.PROVIDER + "/protocol/openid-connect/auth")
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(query.pop("state"), [state])
        # GoTrue always asks for "profile email" and appends the caller's scopes,
        # so HQ must read scope as a set. It sends neither PKCE nor a nonce, and
        # forwards unrecognized authorize parameters (redirect_to) unchanged, so
        # HQ must ignore parameters it does not use.
        self.assertEqual(query, {
            "client_id": ["carbon"],
            "redirect_uri": ["https://api.example.com/auth/v1/callback"],
            "response_type": ["code"],
            "scope": ["profile email profile email"],
            "redirect_to": [self.CALLBACK],
        })

    def test_google_stays_enabled_as_break_glass(self):
        authorization, _ = self.authorize("google", self.CALLBACK)
        self.assertTrue(authorization.startswith("https://accounts.google.com/"))

    def test_canceled_hq_sign_in_returns_only_to_allowlisted_callbacks(self):
        self.assert_destination("https://mes.example.com/callback?redirectTo=%2F", "https://mes.example.com/callback?redirectTo=%2F", "keycloak")
        self.assert_destination("https://evil.example.org/callback", self.site_url, "keycloak")

    def test_new_workspace_member_signs_in_through_the_hook_with_hq_claims_recorded(self):
        result, requests = self.sign_in("new-employee")
        self.assertIn("access_token", result, result)
        self.assertIn("refresh_token", result)
        claims = self.claims(result["access_token"][0])
        self.assertEqual(claims["email"], "new.employee@example.com")
        self.assertEqual([entry["method"] for entry in claims["amr"]], ["oauth"])
        # Server-to-server code exchange with the client secret, then userinfo.
        self.assertEqual([entry["endpoint"] for entry in requests], ["token", "userinfo"])
        self.assertEqual(requests[0]["clientId"], "carbon")
        self.assertEqual(requests[0]["redirectUri"], "https://api.example.com/auth/v1/callback")
        self.assertEqual(requests[0]["grantType"], "authorization_code")
        self.assertFalse(requests[0]["codeVerifier"])
        identity = json.loads(self.sql(f"""
            SELECT json_build_object('provider', provider, 'provider_id', provider_id, 'data', identity_data)
            FROM auth.identities WHERE user_id = '{claims["sub"]}';
        """))
        self.assertEqual(identity["provider"], "keycloak")
        self.assertEqual(identity["provider_id"], "synthetic-subject-new")
        self.assertEqual(identity["data"]["email"], "new.employee@example.com")
        self.assertIs(identity["data"]["email_verified"], True)
        self.assertEqual(identity["data"]["iss"], self.PROVIDER)
        self.assertEqual(identity["data"]["custom_claims"], {"hd": "example.com", "hq_capabilities": ["read:app"]})

    def test_existing_google_account_gains_an_hq_identity_by_verified_email(self):
        result, _ = self.sign_in("linked-employee")
        self.assertIn("access_token", result, result)
        self.assertEqual(self.claims(result["access_token"][0])["sub"], LINKED_USER)
        self.assertEqual(self.sql(f"SELECT string_agg(provider, ',' ORDER BY provider) FROM auth.identities WHERE user_id = '{LINKED_USER}';"), "google,keycloak")
        self.assertEqual(self.sql("SELECT count(*) FROM auth.users WHERE email = 'linked.employee@example.com';"), "1")

    def test_other_workspace_and_unverified_email_get_no_session(self):
        for code, reason in (("other-workspace", "Sign in with an authorized Google Workspace account."),
                             ("unverified", "Unverified email with keycloak")):
            with self.subTest(code=code):
                result, _ = self.sign_in(code)
                self.assertNotIn("access_token", result)
                self.assertNotIn("refresh_token", result)
                self.assertIn(reason, urllib.parse.unquote(result["error_description"][0]))
        # The denied sign-in's transaction is rolled back with the token.
        self.assertEqual(self.sql("SELECT count(*) FROM auth.users WHERE email = 'outsider@example.com';"), "0")


if __name__ == "__main__":
    unittest.main()
