"""Kong's authz_api claim check in the production gateway image (HQ plan 0006B Step 7).

Requires Docker Compose and PyYAML. Renders the stack with HQ sign-in and
AUTHZ_API_CLAIM_REQUIRED on, then runs the rendered Kong (its image, environment
and kong.yml) in front of the rendered GoTrue with the real token hook and the
synthetic HQ provider of test_callback_redirects.py. Synthetic functions stand
in for HQ's authz schema and the projection switch. One stub answers for
PostgREST, Storage, Realtime and the edge runtime and names itself, so a request
that passes Kong is seen to reach the upstream its route names. Nothing external
is contacted.

Run explicitly: python3 -m unittest discover -s contrib/deploying/gcp-tailscale/auth \
-p 'test_kong_authz_api.py'
"""

import base64
import hashlib
import hmac
import http.client
import importlib.util
import json
from pathlib import Path
import time
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("kong_callback_redirects", HERE / "test_callback_redirects.py")
callbacks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(callbacks)

LINKED_USER = callbacks.LINKED_USER
SUBJECT = "user:synthetic-subject-linked"
# Path through Kong -> (resource its route needs, upstream it forwards to, path there).
GATED = {
    "/rest/v1/item?select=id": ("api:supabase.rest", "postgrest", "/item?select=id"),
    "/storage/v1/object/list/private": ("api:supabase.storage", "storage", "/object/list/private"),
    "/functions/v1/create": ("api:supabase.functions", "edge-runtime", "/create"),
    "/realtime/v1/api/broadcast": ("api:supabase.realtime", "realtime", "/api/broadcast"),
}
ALL_APIS = sorted({resource for resource, _, _ in GATED.values()})
# Answers as every API upstream on its rendered port, naming itself.
UPSTREAMS = r"""
import { createServer } from "node:http";
const names = { 3000: "postgrest", 4000: "realtime", 5000: "storage", 9000: "edge-runtime" };
for (const [port, upstream] of Object.entries(names)) {
  createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ upstream, path: req.url }));
    });
  }).listen(Number(port), "0.0.0.0");
}
"""


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def sign(claims, secret):
    """An HS256 token as Carbon's server signs one (getUserScopedClient)."""
    token = encode(b'{"alg":"HS256","typ":"JWT"}') + "." + encode(json.dumps(claims).encode())
    return token + "." + encode(hmac.new(secret.encode(), token.encode(), hashlib.sha256).digest())


class KongAuthzApiTests(callbacks.HqSignInStack):
    CHANGES = {**callbacks.HqSignInStack.CHANGES, "AUTHZ_API_CLAIM_REQUIRED": "true"}

    @classmethod
    def peers(cls, directory, auth):
        peers = super().peers(directory, auth)
        cls.directory = directory
        rendered = json.loads((directory / "rendered/compose.json").read_text())
        kong = rendered["services"]["kong"]
        if "pre-function" not in kong["environment"]["KONG_PLUGINS"]:
            raise AssertionError("The renderer did not enable the authz_api check")
        # The production image, environment and rendered kong.yml are kept; only
        # the probe cadence and a loopback port are fixture choices.
        kong.update({
            "restart": "no",
            "ports": ["127.0.0.1::8000"],
            "depends_on": {"gotrue": {"condition": "service_healthy"}, "upstreams": {"condition": "service_healthy"}},
            "healthcheck": {**kong["healthcheck"], "interval": "1s", "retries": 60},
        })
        script = directory / "upstreams.mjs"
        script.write_text(UPSTREAMS)
        script.chmod(0o444)
        probe = "Promise.all([3000, 4000, 5000, 9000].map(p => fetch('http://127.0.0.1:' + p))).then(() => process.exit(0), () => process.exit(1))"
        return {**peers, "kong": kong, "upstreams": {
            "image": "node:22-bookworm-slim",
            "networks": {"internal": {"aliases": ["postgrest", "storage", "realtime", "realtime-dev", "edge-runtime"]}},
            "command": ["node", "/stub/upstreams.mjs"],
            "volumes": [str(script) + ":/stub/upstreams.mjs:ro"],
            "healthcheck": {"test": ["CMD", "node", "-e", probe], "interval": "1s", "timeout": "2s", "retries": 45},
        }}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # HQ's authz schema and the projection switch, as Carbon's migration and
        # HQ provision them; the hook calls only these three functions.
        cls.sql(f"""
            CREATE TABLE public.kong_test_authz (auth_uid UUID PRIMARY KEY, subject TEXT, capabilities TEXT[] NOT NULL);
            INSERT INTO public.kong_test_authz VALUES ('{LINKED_USER}', '{SUBJECT}', '{{}}');
            CREATE FUNCTION carbon_private.authz_projection_enabled() RETURNS BOOLEAN
              LANGUAGE sql STABLE AS $$ SELECT true $$;
            CREATE SCHEMA authz;
            CREATE FUNCTION authz.subject_of_auth_user(UUID) RETURNS TEXT
              LANGUAGE sql STABLE AS $$ SELECT subject FROM public.kong_test_authz WHERE auth_uid = $1 $$;
            CREATE FUNCTION authz.capabilities(TEXT, TEXT) RETURNS TEXT[]
              LANGUAGE sql STABLE AS $$
                SELECT CASE WHEN $2 = 'api' THEN capabilities END FROM public.kong_test_authz WHERE subject = $1 $$;
        """)
        host, port = cls.compose("port", "kong", "8000").stdout.strip().rsplit(":", 1)
        cls.gateway = (host, int(port))
        cls.anon = (cls.directory / "secrets/anon_key").read_text().strip()
        cls.service_role = (cls.directory / "secrets/service_role_key").read_text().strip()
        cls.jwt_secret = (cls.directory / "secrets/jwt_secret").read_text().strip()

    def setUp(self):
        super().setUp()
        self.grant()
        self.addCleanup(self.sql, f"UPDATE public.kong_test_authz SET subject = '{SUBJECT}', capabilities = '{{}}';")

    def grant(self, *resources):
        """authz's api: grants for the person, as 'use:<resource>' capabilities."""
        array = ",".join('"use:' + resource + '"' for resource in resources)
        self.sql(f"UPDATE public.kong_test_authz SET capabilities = '{{{array}}}';")

    def call(self, path, *, token=None, method="GET", headers=(), body=None):
        """One request through Kong, as supabase-js sends it: the anon apikey plus the bearer."""
        connection = http.client.HTTPConnection(*self.gateway, timeout=15)
        try:
            connection.putrequest(method, path, skip_accept_encoding=True)
            sent = list(headers)
            if token is not None:
                sent += [("apikey", self.anon), ("Authorization", "Bearer " + token)]
            data = None if body is None else json.dumps(body).encode()
            if data is not None:
                sent += [("Content-Type", "application/json"), ("Content-Length", str(len(data)))]
            for name, value in sent:
                connection.putheader(name, value)
            connection.endheaders(data)
            response = connection.getresponse()
            raw = response.read()
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = raw.decode(errors="replace")
            return response.status, payload, response.headers
        finally:
            connection.close()

    def signed_in(self):
        result, _ = self.sign_in("linked-employee")
        self.assertIn("access_token", result, result)
        return result["access_token"][0], result["refresh_token"][0]

    def refreshed(self, refresh_token):
        """GoTrue's refresh through Kong, which leaves /auth/v1/ open."""
        status, body, _ = self.call("/auth/v1/token?grant_type=refresh_token", method="POST",
                                    headers=[("apikey", self.anon)], body={"refresh_token": refresh_token})
        self.assertEqual(status, 200, body)
        return body["access_token"], body["refresh_token"]

    def assert_denied(self, path, token, status=403):
        answer, body, _ = self.call(path, token=token)
        self.assertEqual(answer, status, (path, body))
        self.assertNotIn("upstream", body)

    def assert_reaches(self, path, token=None, **options):
        status, body, _ = self.call(path, token=token, **options)
        self.assertEqual(status, 200, (path, body))
        self.assertEqual(body, {"upstream": GATED[path][1], "path": GATED[path][2]})

    def test_storage_answers_403_without_its_grant_and_reaches_storage_with_it(self):
        # 0006B Step 7's first Accept line, through the real hook and gateway.
        self.grant("api:supabase.rest")
        access, refresh = self.signed_in()
        claims = self.claims(access)
        self.assertEqual(claims["authz_api"], ["api:supabase.rest"])
        # The check relies on GoTrue's tokens carrying a session_id.
        self.assertTrue(claims["session_id"])
        self.assert_denied("/storage/v1/object/list/private", access)
        self.assert_reaches("/rest/v1/item?select=id", access)
        # A grant reaches the API at the next refresh...
        self.grant("api:supabase.rest", "api:supabase.storage")
        access, refresh = self.refreshed(refresh)
        self.assertEqual(self.claims(access)["authz_api"], ["api:supabase.rest", "api:supabase.storage"])
        self.assert_reaches("/storage/v1/object/list/private", access)
        # ...and so does a revoke, within one access-token lifetime.
        self.grant("api:supabase.rest")
        access, _ = self.refreshed(refresh)
        self.assert_denied("/storage/v1/object/list/private", access)

    def test_every_api_route_needs_its_own_grant_and_gotrue_stays_open(self):
        access, refresh = self.signed_in()
        self.assertEqual(self.claims(access)["authz_api"], [])
        for path in GATED:
            with self.subTest(path=path):
                self.assert_denied(path, access)
        # Realtime's socket presents its credential as the apikey query argument.
        self.assert_denied("/realtime/v1/websocket?vsn=1.0.0&apikey=" + access, None)
        for path in ("/auth/v1/health", "/auth/v1/settings"):
            status, body, _ = self.call(path, headers=[("apikey", self.anon)])
            self.assertEqual(status, 200, (path, body))
        status, body, _ = self.call("/auth/v1/user", token=access)
        self.assertEqual((status, body.get("id")), (200, LINKED_USER))
        for granted in ALL_APIS:
            self.grant(granted)
            access, refresh = self.refreshed(refresh)
            for path, (resource, _, _) in GATED.items():
                with self.subTest(granted=granted, path=path):
                    if resource == granted:
                        self.assert_reaches(path, access)
                    else:
                        self.assert_denied(path, access)
        self.grant(*ALL_APIS)
        access, _ = self.refreshed(refresh)
        status, body, _ = self.call("/realtime/v1/websocket?vsn=1.0.0&apikey=" + access)
        self.assertEqual((status, body["upstream"]), (200, "realtime"), body)

    def test_authz_api_written_into_user_metadata_changes_nothing(self):
        # 0006B Step 7's second Accept line: the person edits their own metadata.
        access, refresh = self.signed_in()
        status, body, _ = self.call("/auth/v1/user", token=access, method="PUT",
                                    body={"data": {"authz_api": ALL_APIS}})
        self.assertEqual(status, 200, body)
        access, _ = self.refreshed(refresh)
        claims = self.claims(access)
        self.assertEqual(claims["user_metadata"]["authz_api"], ALL_APIS)
        self.assertEqual(claims["authz_api"], [])
        for path in GATED:
            with self.subTest(path=path):
                self.assert_denied(path, access)

    def test_a_disabled_subject_cannot_refresh(self):
        # 0006B Step 7's third Accept line: the hook refuses, through the gateway.
        self.grant(*ALL_APIS)
        _, refresh = self.signed_in()
        self.sql("UPDATE public.kong_test_authz SET subject = NULL;")
        status, body, _ = self.call("/auth/v1/token?grant_type=refresh_token", method="POST",
                                    headers=[("apikey", self.anon)], body={"refresh_token": refresh})
        self.assertEqual((status, body.get("msg")), (403, "Your account is not active in HQ."), body)
        self.assertNotIn("access_token", body)
        self.assertNotIn("refresh_token", body)

    def test_anon_service_role_and_server_signed_tokens_keep_their_routes(self):
        now = int(time.time())
        # getUserScopedClient's shape: no session_id, never sent to a browser.
        server_signed = sign({"sub": LINKED_USER, "aud": "authenticated", "role": "authenticated",
                              "iat": now, "exp": now + 300}, self.jwt_secret)
        for label, token in (("anon", self.anon), ("service_role", self.service_role), ("server-signed", server_signed)):
            for path in GATED:
                with self.subTest(label, path=path):
                    self.assert_reaches(path, token)
        for path in GATED:  # no credential at all: public objects, image uploads
            with self.subTest("none", path=path):
                self.assert_reaches(path)
        status, body, _ = self.call("/realtime/v1/websocket?vsn=1.0.0&apikey=" + self.anon)
        self.assertEqual((status, body["upstream"]), (200, "realtime"), body)

    def test_every_credential_location_is_checked_and_malformed_ones_are_refused(self):
        access, _ = self.signed_in()
        path = "/rest/v1/item?select=id"
        service = [("Authorization", "Bearer " + self.service_role)]
        for label, headers, status in (
            ("apikey header", service + [("apikey", access)], 403),
            ("x-api-key header", service + [("x-api-key", access)], 403),
            ("second apikey", service + [("apikey", self.anon), ("apikey", access)], 403),
            ("basic", [("Authorization", "Basic c3ludGhldGljOnNlY3JldA==")], 401),
            ("not a JWT", [("Authorization", "Bearer synthetic-opaque-token")], 401),
            ("two spaces", [("Authorization", "Bearer  " + access)], 401),
            ("empty apikey", [("apikey", "")], 401),
            # nginx refuses a repeated Authorization header before any plugin runs.
            ("second authorization", service + [("Authorization", "Bearer " + access)], 400),
        ):
            with self.subTest(label):
                answer, body, _ = self.call(path, headers=headers)
                self.assertEqual(answer, status, body)
                self.assertNotIn("upstream", body)
        for query, status in (("&apikey=" + access, 403), ("&apikey=" + self.anon + "&apikey=" + access, 403), ("&apikey", 401)):
            with self.subTest(query=query[:20]):
                self.assert_denied(path + query, None, status)

    def test_denials_keep_cors_headers_and_preflights_pass(self):
        access, _ = self.signed_in()
        origin = [("Origin", "https://erp.example.com")]
        status, body, headers = self.call("/storage/v1/object/list/private", token=access, headers=origin)
        self.assertEqual((status, body), (403, {"message": "This API is not granted to the signed-in user"}))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIsNotNone(headers["Access-Control-Allow-Origin"])
        status, _, headers = self.call("/storage/v1/object/list/private", method="OPTIONS", headers=origin + [
            ("Access-Control-Request-Method", "POST"), ("Access-Control-Request-Headers", "authorization,apikey")])
        self.assertEqual(status, 200)
        self.assertIn("authorization", headers["Access-Control-Allow-Headers"])


if __name__ == "__main__":
    unittest.main()
