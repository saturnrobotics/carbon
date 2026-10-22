"""Kong's storage gate in the production gateway image (storage_api.py).

GHSA-8rrf-w776-x75g and GHSA-67rp-h2mf-ph72. Requires Docker Compose and PyYAML.
Renders the stack, then runs the rendered Kong (its image, environment and
kong.yml) in front of one stub that answers for every upstream and names the
method and path it received, so a request that passes Kong is seen to reach
Storage with the path Storage would route. The second class renders with HQ
sign-in and the authz_api claim on, and shows both checks run, the gate first.
Nothing external is contacted; the advisories' exploit shapes against a real
storage-api are recorded with the change that added this test.

Run explicitly: python3 -m unittest discover -s contrib/deploying/gcp-tailscale/auth \
-p 'test_kong_storage_gate.py'
"""

import base64
import contextlib
import hashlib
import hmac
import http.client
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parent
REPO = DEPLOY.parents[2]
sys.path.insert(0, str(DEPLOY))
spec = importlib.util.spec_from_file_location("storage_gate_render", DEPLOY / "render.py")
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)

S3 = "The S3 protocol is not available"
SIGNED = "Signed resumable uploads are not available"
BEARER = "Resumable uploads require a bearer token"
UPLOAD_ID = "cHJpdmF0ZS9jb21wYW55L21vZGVscy9wYXJ0LnN0ZXAvdmVyc2lvbg"
# Answers as every upstream on its rendered port, naming itself and the request.
UPSTREAMS = r"""
import { createServer } from "node:http";
const names = { 9999: "gotrue", 3000: "postgrest", 4000: "realtime", 5000: "storage", 9000: "edge-runtime" };
for (const [port, upstream] of Object.entries(names)) {
  createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "x-upstream": upstream, "x-upstream-path": req.url });
      res.end(JSON.stringify({ upstream, method: req.method, path: req.url }));
    });
  }).listen(Number(port), "0.0.0.0");
}
"""


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def sign(claims, secret):
    token = encode(b'{"alg":"HS256","typ":"JWT"}') + "." + encode(json.dumps(claims).encode())
    return token + "." + encode(hmac.new(secret.encode(), token.encode(), hashlib.sha256).digest())


class StorageGateTests(unittest.TestCase):
    CHANGES = {}

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="carbon-storage-gate-")
        cls.addClassCleanup(cls.temporary.cleanup)
        directory = Path(cls.temporary.name)
        cls.project = "carbon-storage-gate-" + uuid.uuid4().hex[:12]
        cls.compose_file = directory / "compose.json"
        config = {
            "ERP_HOST": "erp.example.com", "MES_HOST": "mes.example.com", "SUPABASE_HOST": "api.example.com",
            "DNS_DOMAIN": "example.com", "AUTH_ALLOWED_GOOGLE_DOMAIN": "example.com", "TAILSCALE_IP": "100.72.10.8",
            "DEPLOY_REVISION": "a" * 40, "GOOGLE_CLIENT_ID": "synthetic-client", "GOOGLE_CLIENT_SECRET": "synthetic-secret",
            "SOURCE_CODE_URL": "https://github.com/example/carbon/tree/" + "a" * 40, **cls.CHANGES,
        }
        with contextlib.redirect_stderr(io.StringIO()):
            stack, _ = render.render(config, REPO, directory / "rendered", directory)
        kong = stack["services"]["kong"]
        if "pre-function" not in kong["environment"]["KONG_PLUGINS"].split(","):
            raise AssertionError("The renderer did not enable the storage gate")
        # The production image, environment and rendered kong.yml are kept; only
        # the probe cadence and a loopback port are fixture choices.
        kong.update({
            "restart": "no",
            "ports": ["127.0.0.1::8000"],
            "depends_on": {"upstreams": {"condition": "service_healthy"}},
            "healthcheck": {**kong["healthcheck"], "interval": "1s", "retries": 60},
        })
        script = directory / "upstreams.mjs"
        script.write_text(UPSTREAMS)
        script.chmod(0o444)
        probe = "Promise.all([9999, 3000, 4000, 5000, 9000].map(p => fetch('http://127.0.0.1:' + p))).then(() => process.exit(0), () => process.exit(1))"
        fixture = {
            "services": {"kong": kong, "upstreams": {
                "image": "node:22-bookworm-slim",
                "networks": {"internal": {"aliases": ["gotrue", "postgrest", "storage", "realtime", "realtime-dev", "edge-runtime"]}},
                "command": ["node", "/stub/upstreams.mjs"],
                "volumes": [str(script) + ":/stub/upstreams.mjs:ro"],
                "healthcheck": {"test": ["CMD", "node", "-e", probe], "interval": "1s", "timeout": "2s", "retries": 45},
            }},
            "networks": {"internal": {"driver": "bridge"}},
        }
        cls.compose_file.write_text(json.dumps(fixture))
        cls.addClassCleanup(cls.compose, "down", "--volumes", "--remove-orphans")
        try:
            cls.compose("up", "--detach", "--wait", "--wait-timeout", "120", timeout=240)
        except AssertionError as error:
            raise AssertionError(cls.compose("logs", "--tail", "40", "kong").stdout) from error
        host, port = cls.compose("port", "kong", "8000").stdout.strip().rsplit(":", 1)
        cls.gateway = (host, int(port))
        cls.anon = (directory / "secrets/anon_key").read_text().strip()
        cls.service_role = (directory / "secrets/service_role_key").read_text().strip()
        now = int(time.time())
        # As Carbon's server signs a user's token (getUserScopedClient): no session_id.
        cls.user = sign({"sub": str(uuid.uuid4()), "aud": "authenticated", "role": "authenticated",
                         "iat": now, "exp": now + 600}, (directory / "secrets/jwt_secret").read_text().strip())
        cls.jwt_secret = (directory / "secrets/jwt_secret").read_text().strip()

    @classmethod
    def compose(cls, *arguments, timeout=60):
        result = subprocess.run(
            ["docker", "compose", "--project-name", cls.project, "--file", str(cls.compose_file), *arguments],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return result

    def call(self, method, target, headers=()):
        """One request with the exact request target, as a client could send it."""
        connection = http.client.HTTPConnection(*self.gateway, timeout=15)
        try:
            connection.putrequest(method, target, skip_accept_encoding=True)
            for name, value in headers:
                connection.putheader(name, value)
            connection.endheaders()
            response = connection.getresponse()
            raw = response.read()
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw.decode(errors="replace")
            return response.status, body, response.headers
        finally:
            connection.close()

    def bearer(self, token):
        return [("Authorization", "Bearer " + token), ("apikey", self.anon)]

    def assert_refused(self, method, target, headers, status, message):
        answer, body, received = self.call(method, target, headers)
        self.assertEqual(answer, status, (method, target, body))
        self.assertIsNone(received["x-upstream"], (method, target))
        if method != "HEAD":
            self.assertEqual(body, {"message": message}, (method, target))
        self.assertEqual(received["Cache-Control"], "no-store")

    def assert_reaches(self, method, target, headers, path):
        status, body, received = self.call(method, target, headers)
        self.assertEqual(status, 200, (method, target, body))
        self.assertEqual((received["x-upstream"], received["x-upstream-path"]), ("storage", path), (method, target))

    def test_carbons_storage_requests_reach_storage_unchanged(self):
        user = self.bearer(self.user)
        for method, target, headers, path in (
            ("GET", "/storage/v1/object/public/public/logo.png", [], "/object/public/public/logo.png"),
            ("POST", "/storage/v1/object/private/company/doc.pdf", user, "/object/private/company/doc.pdf"),
            ("GET", "/storage/v1/object/sign/private/company/doc.pdf?token=t", [], "/object/sign/private/company/doc.pdf?token=t"),
            # The jobs' late-minted signed upload (createSignedUploadUrl): no bearer.
            ("PUT", "/storage/v1/object/upload/sign/private/company/m.glb?token=t", [], "/object/upload/sign/private/company/m.glb?token=t"),
            # apps/erp/app/utils/resumable-upload.ts: create, chunks, resume.
            ("POST", "/storage/v1/upload/resumable", user, "/upload/resumable"),
            ("PATCH", "/storage/v1/upload/resumable/" + UPLOAD_ID, user, "/upload/resumable/" + UPLOAD_ID),
            ("HEAD", "/storage/v1/upload/resumable/" + UPLOAD_ID, user, "/upload/resumable/" + UPLOAD_ID),
            ("POST", "/storage/v1/upload/resumable", self.bearer(self.service_role), "/upload/resumable"),
            # The anon key is a bearer too; Storage applies row level security as anon.
            ("POST", "/storage/v1/upload/resumable", self.bearer(self.anon), "/upload/resumable"),
            ("OPTIONS", "/storage/v1/upload/resumable", [], "/upload/resumable"),
            ("GET", "/storage/v1/version", [], "/version"),
        ):
            with self.subTest(method=method, target=target):
                self.assert_reaches(method, target, headers, path)

    def test_the_s3_protocol_is_refused_in_every_spelling(self):
        for target in ("/storage/v1/s3", "/storage/v1/s3/", "/storage/v1/s3/private/company/doc.pdf",
                       "/storage/v1/S3/", "/storage/v1/%73%33/", "/storage/v1/%2573%2533/", "/storage/v1//s3/",
                       "/storage/v1/./s3/", "/storage/v1/object/../s3/", "/storage/v1/s3;x/private",
                       "http://api.example.com/storage/v1/s3/"):
            for method in ("GET", "PUT", "POST", "DELETE"):
                for label, headers in (("no credential", []), ("service_role", self.bearer(self.service_role))):
                    with self.subTest(method=method, target=target, credential=label):
                        self.assert_refused(method, target, headers, 403, S3)

    def test_signed_resumable_uploads_are_refused_in_every_spelling(self):
        signed = self.bearer(self.user) + [("x-signature", "synthetic"), ("Tus-Resumable", "1.0.0")]
        for target in ("/storage/v1/upload/resumable/sign", "/storage/v1/upload/resumable/sign/",
                       "/storage/v1/upload/resumable/sign/" + UPLOAD_ID, "/storage/v1/upload/resumable/%73ign",
                       "/storage/v1/upload/resumable/%2573ign", "/storage/v1/upload/resumable/SIGN",
                       "/storage/v1/upload/resumable%2Fsign/" + UPLOAD_ID, "/storage/v1/upload//resumable/sign",
                       "/storage/v1/%75pload/resumable/sign", "/storage/v1/upload/resumable/x/../sign",
                       "http://api.example.com/storage/v1/upload/resumable/sign"):
            for method in ("POST", "PATCH", "HEAD", "OPTIONS"):
                for label, headers in (("signature and bearer", signed), ("nothing", [])):
                    with self.subTest(method=method, target=target, credential=label):
                        self.assert_refused(method, target, headers, 403, SIGNED)

    def test_resumable_uploads_need_a_bearer(self):
        tus = [("Tus-Resumable", "1.0.0"), ("Upload-Length", "0")]
        for label, headers in (
            ("nothing", tus),
            ("apikey only", tus + [("apikey", self.anon)]),
            ("basic", tus + [("Authorization", "Basic c3ludGhldGljOnNlY3JldA==")]),
            ("not a JWT", tus + [("Authorization", "Bearer synthetic-opaque-token")]),
            ("two spaces", tus + [("Authorization", "Bearer  " + self.user)]),
            ("empty bearer", tus + [("Authorization", "Bearer ")]),
        ):
            for method, target in (("POST", "/storage/v1/upload/resumable"), ("POST", "/storage/v1/upload/resumable/"),
                                   ("PATCH", "/storage/v1/upload/resumable/" + UPLOAD_ID),
                                   ("HEAD", "/storage/v1/upload/resumable/" + UPLOAD_ID),
                                   ("POST", "/storage/v1/%75pload/resumable"), ("POST", "/storage/v1/Upload/Resumable"),
                                   ("POST", "http://api.example.com/storage/v1/upload/resumable")):
                with self.subTest(label, method=method, target=target):
                    self.assert_refused(method, target, headers, 401, BEARER)
        # The TUS server honours a method override, so such an OPTIONS is an upload.
        self.assert_refused("OPTIONS", "/storage/v1/upload/resumable", tus + [("X-HTTP-Method-Override", "POST")], 401, BEARER)

    def test_denials_keep_cors_headers_and_preflights_pass(self):
        origin = [("Origin", "https://erp.example.com")]
        for target, status, message in (("/storage/v1/s3/", 403, S3), ("/storage/v1/upload/resumable", 401, BEARER)):
            with self.subTest(target=target):
                answer, body, headers = self.call("POST", target, origin)
                self.assertEqual((answer, body), (status, {"message": message}))
                self.assertIsNotNone(headers["Access-Control-Allow-Origin"])
        status, _, headers = self.call("OPTIONS", "/storage/v1/upload/resumable", origin + [
            ("Access-Control-Request-Method", "POST"),
            ("Access-Control-Request-Headers", "authorization,apikey,x-upsert,tus-resumable,upload-length,upload-metadata")])
        self.assertEqual(status, 200)
        self.assertIsNone(headers["x-upstream"])  # Kong's cors plugin answered
        self.assertIn("upload-metadata", headers["Access-Control-Allow-Headers"])


class StorageGateWithAuthzApiTests(StorageGateTests):
    """The same gate with the authz_api claim on: both run, the gate first."""

    CHANGES = {"HQ_SIGN_IN_ENABLED": "true", "HQ_ISSUER": "https://hq.example.com",
               "HQ_OIDC_CARBON_SECRET": "synthetic-hq-client-secret-" + "x" * 16, "AUTHZ_API_CLAIM_REQUIRED": "true"}

    def gotrue_token(self, **extra):
        now = int(time.time())
        nobody = "00000000-0000-0000-0000-000000000000"
        return sign({"sub": nobody, "session_id": nobody, "aud": "authenticated", "role": "authenticated",
                     "iat": now, "exp": now + 60, **extra}, self.jwt_secret)

    def test_the_gate_runs_before_the_authz_api_check(self):
        ungranted, granted = self.gotrue_token(), self.gotrue_token(authz_api=["api:supabase.storage"])
        self.assert_refused("GET", "/storage/v1/s3/", self.bearer(granted), 403, S3)
        self.assert_refused("POST", "/storage/v1/upload/resumable/sign", self.bearer(granted), 403, SIGNED)
        self.assert_refused("POST", "/storage/v1/upload/resumable", self.bearer(ungranted), 403,
                            "This API is not granted to the signed-in user")
        self.assert_reaches("POST", "/storage/v1/upload/resumable", self.bearer(granted), "/upload/resumable")


if __name__ == "__main__":
    unittest.main()
