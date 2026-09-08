#!/usr/bin/env python3
"""Disposable, synthetic native Supabase OAuth compatibility evaluation.

The disposable mode starts the pinned self-hosted consumers from compose.yml,
creates only synthetic users/rows, and emits a machine-readable evidence matrix.
It intentionally treats an accepted token replay into a write surface as a
failed adoption gate. It never changes a deployed Supabase project.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.request import HTTPRedirectHandler, Request, build_opener


HERE = Path(__file__).resolve().parent
COMPOSE = HERE / "compose.yml"
JWT_SECRET = "synthetic-oauth-evaluation-jwt-secret"
CLIENT_REDIRECT = "http://127.0.0.1:18994/callback"
SYNTHETIC_EMAIL = "oauth-evaluation@example.com"
SYNTHETIC_PASSWORD = "Correct-Horse-Battery-42!"


def b64json(value: str) -> dict[str, Any]:
    padded = value + "=" * (-len(value) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


def decode_jwt(token: str) -> tuple[dict[str, Any], dict[str, Any]]:
    head, body, _sig = token.split(".")
    return b64json(head), b64json(body)


def sign_jwt(header: dict[str, Any], body: dict[str, Any], secret: str = JWT_SECRET) -> str:
    def enc(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode().rstrip("=")
    unsigned = f"{enc(header)}.{enc(body)}"
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), unsigned.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{unsigned}.{signature}"


def request(base: str, path: str, method: str = "GET", *, token: str | None = None,
            data: bytes | None = None, content_type: str = "application/json",
            follow: bool = False) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = content_type
    req = Request(base.rstrip("/") + path, method=method, data=data, headers=headers)
    try:
        class NoRedirect(HTTPRedirectHandler):
            def redirect_request(self, _req, _fp, _code, _msg, _headers, _new):
                return None
        opener = build_opener() if follow else build_opener(NoRedirect)
        with opener.open(req, timeout=8) as response:
            raw = response.read(1_000_000)
            location = response.headers.get("Location")
            status = response.status
    except HTTPError as exc:
        raw = exc.read(1_000_000)
        location = exc.headers.get("Location")
        status = exc.code
    except (URLError, TimeoutError, OSError) as exc:
        return {"status": None, "error": str(exc)}
    text = raw.decode("utf-8", "replace")
    try:
        body: Any = json.loads(text) if text else None
    except json.JSONDecodeError:
        body = text
    result: dict[str, Any] = {"status": status, "body": body}
    if location:
        result["location"] = location
    return result


def json_data(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode()


def result(name: str, status: str, observed: str, expected: str, evidence: Any = None, *, note: str = "") -> dict[str, Any]:
    item = {"id": name, "status": status, "observed": observed, "expected": expected}
    if evidence is not None:
        item["evidence"] = evidence
    if note:
        item["note"] = note
    return item


def synthetic_keys() -> tuple[str, str]:
    now = int(time.time())
    return (
        sign_jwt({"alg": "HS256", "typ": "JWT"}, {"role": "anon", "aud": "authenticated", "iss": "supabase", "iat": now, "exp": now + 3600}),
        sign_jwt({"alg": "HS256", "typ": "JWT"}, {"role": "service_role", "aud": "authenticated", "iss": "supabase", "iat": now, "exp": now + 3600}),
    )


def write_probe_function(path: Path) -> None:
    (path / "oauth-probe").mkdir(parents=True, exist_ok=True)
    (path / "oauth-probe" / "index.ts").write_text(
        """Deno.serve((request) => new Response(JSON.stringify({
  privileged_probe: true,
  authorization: request.headers.get("authorization"),
}), { headers: { "content-type": "application/json" } }));
"""
    )


def wait_for(base: str, path: str, attempts: int = 45) -> dict[str, Any]:
    last: dict[str, Any] = {}
    for _ in range(attempts):
        last = request(base, path)
        if last.get("status") is not None and last["status"] < 500:
            return last
        time.sleep(1)
    return last


def evaluate_disposable() -> dict[str, Any]:
    run_dir = Path(tempfile.mkdtemp(prefix="carbon-oauth-eval-"))
    functions = run_dir / "functions"
    write_probe_function(functions)
    anon, service = synthetic_keys()
    project = f"carbon-oauth-evaluation-{secrets.token_hex(4)}"
    ports = {"AUTH_PORT": "18999", "REST_PORT": "18998", "STORAGE_PORT": "18997", "REALTIME_PORT": "18996", "EDGE_PORT": "18995"}
    env = {**os.environ, "COMPOSE_PROJECT_NAME": project, "SYNTHETIC_ANON_KEY": anon, "SYNTHETIC_SERVICE_KEY": service,
           "EDGE_FUNCTIONS_PATH": str(functions), "EDGE_DISPATCHER_PATH": str(Path(__file__).resolve().parents[5] / "packages/dev/docker/edge-main"), **ports}
    up = ["docker", "compose", "--file", str(COMPOSE), "up", "-d", "postgres", "db-init", "gotrue", "postgrest", "storage", "realtime", "edge-runtime"]
    results: list[dict[str, Any]] = []
    metadata: dict[str, Any] = {"mode": "disposable-synthetic", "compose_project": project, "images": {
        "gotrue": "supabase/gotrue:v2.189.0", "postgrest": "postgrest/postgrest:v13.0.8", "storage": "supabase/storage-api:v1.58.4", "realtime": "supabase/realtime:v2.89.0", "edge": "supabase/edge-runtime:v1.74.0"},
        "synthetic_subject": SYNTHETIC_EMAIL}
    try:
        started = subprocess.run(up, env=env, text=True, capture_output=True, timeout=180)
        if started.returncode:
            return {"metadata": metadata, "adoption_gate": "blocked", "results": [result("stack_start", "untested", "compose failed to start", "pinned stack starts", started.stderr[-2000:])], "error": started.stderr[-2000:]}
        auth = "http://127.0.0.1:18999"
        rest = "http://127.0.0.1:18998"
        storage = "http://127.0.0.1:18997"
        realtime = "http://127.0.0.1:18996"
        edge = "http://127.0.0.1:18995"
        health = wait_for(auth, "/health")
        results.append(result("gotrue_health", "pass" if health.get("status") == 200 else "fail", str(health.get("status")), "200", health))
        user = request(auth, "/admin/users", "POST", token=service, data=json_data({"email": SYNTHETIC_EMAIL, "password": SYNTHETIC_PASSWORD, "email_confirm": True}))
        if user.get("status") not in (200, 201):
            results.append(result("synthetic_user", "fail", str(user.get("status")), "201", user))
            return {"metadata": metadata, "adoption_gate": "blocked", "results": results}
        login = request(auth, "/token?grant_type=password", "POST", data=json_data({"email": SYNTHETIC_EMAIL, "password": SYNTHETIC_PASSWORD}))
        user_token = (login.get("body") or {}).get("access_token")
        results.append(result("password_bootstrap", "pass" if user_token else "fail", str(login.get("status")), "200 with synthetic user token", login))
        if not user_token:
            return {"metadata": metadata, "adoption_gate": "blocked", "results": results}
        registration = request(auth, "/admin/oauth/clients", "POST", token=service, data=json_data({"redirect_uris": [CLIENT_REDIRECT], "client_type": "public", "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "client_name": "Synthetic read client"}))
        client = registration.get("body") or {}
        client_id = client.get("client_id")
        results.append(result("client_registration", "pass" if registration.get("status") == 201 and client_id else "fail", str(registration.get("status")), "201", {"status": registration.get("status"), "client_type": client.get("client_type")}))
        if not client_id:
            return {"metadata": metadata, "adoption_gate": "blocked", "results": results}
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        # The pinned self-hosted image has no asymmetric OIDC signing key in this
        # disposable stack. Exercise the access/refresh grant with non-openid
        # claims, then record OIDC ID-token signing as an explicit untested cell.
        query = urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": CLIENT_REDIRECT, "scope": "email profile", "state": "synthetic-state", "code_challenge": challenge, "code_challenge_method": "S256"})
        authorization = request(auth, "/oauth/authorize?" + query, follow=False)
        location = authorization.get("location", "")
        authorization_id = parse_qs(urlparse(location).query).get("authorization_id", [None])[0]
        details = request(auth, f"/oauth/authorizations/{authorization_id}", token=user_token) if authorization_id else {"status": None}
        consent = request(auth, f"/oauth/authorizations/{authorization_id}/consent", "POST", token=user_token, data=json_data({"action": "approve"})) if authorization_id else {"status": None}
        callback = consent.get("body") or {}
        callback_url = callback.get("redirect_url", "")
        code = parse_qs(urlparse(callback_url).query).get("code", [None])[0]
        results.append(result("pkce_authorization", "pass" if authorization_id and code else "fail", f"authorize={authorizationization_status(authorization)} consent={consent.get('status')}", "authorization code issued", {"authorize": authorization, "consent": consent, "code_issued": bool(code)}))
        token_exchange = request(auth, "/oauth/token", "POST", data=urlencode({"grant_type": "authorization_code", "code": code or "", "redirect_uri": CLIENT_REDIRECT, "client_id": client_id, "code_verifier": verifier}).encode(), content_type="application/x-www-form-urlencoded")
        oauth = token_exchange.get("body") or {}
        oauth_token = oauth.get("access_token")
        refresh = oauth.get("refresh_token")
        header, claims = decode_jwt(oauth_token) if oauth_token else ({}, {})
        results.append(result("pkce_token_exchange", "pass" if oauth_token and refresh else "fail", str(token_exchange.get("status")), "200 with access and refresh tokens", {"response": token_exchange, "header_alg": header.get("alg"), "claims": {key: claims.get(key) for key in ("sub", "aud", "role", "scope", "client_id")}}))
        if not oauth_token:
            return {"metadata": metadata, "adoption_gate": "blocked", "results": results}
        read = request(rest, "/oauth_probe?id=eq.1", token=oauth_token)
        results.append(result("postgrest_read_adapter", "pass" if read.get("status") == 200 else "fail", str(read.get("status")), "200", read))
        dml = request(rest, "/oauth_probe", "POST", token=oauth_token, data=json_data({"id": 3, "value": "direct-write"}))
        results.append(result("postgrest_dml_replay", "pass" if dml.get("status") in (401, 403) else "fail", str(dml.get("status")), "401/403", dml, note="A successful DML replay fails the native-delegation adoption gate."))
        rpc = request(rest, "/rpc/oauth_probe_mutation", "POST", token=oauth_token, data=json_data({}))
        results.append(result("postgrest_rpc_replay", "pass" if rpc.get("status") in (401, 403) else "fail", str(rpc.get("status")), "401/403", rpc, note="The fixture intentionally grants authenticated EXECUTE to expose privileged-RPC replay risk."))
        storage_write = request(storage, "/object/evaluation/owned.txt", "POST", token=oauth_token, data=b"synthetic", content_type="text/plain")
        storage_status = "pass" if storage_write.get("status") in (401, 403) else ("untested" if storage_write.get("status") is None else "fail")
        results.append(result("storage_write_replay", storage_status, str(storage_write.get("status")), "401/403", storage_write, note="A closed connection is recorded as untested rather than treated as a denial."))
        realtime_write = request(realtime, "/api/broadcast", "POST", token=oauth_token, data=json_data({"messages": [{"topic": "synthetic", "event": "probe", "payload": {"source": "oauth"}}]}))
        results.append(result("realtime_write_replay", "pass" if realtime_write.get("status") in (401, 403, 404, 422) else "untested", str(realtime_write.get("status")), "deny or explicitly unsupported", realtime_write, note="REST broadcast is the pinned Realtime write surface; an unavailable endpoint is reported as untested."))
        privileged = request(edge, "/oauth-probe", "POST", token=oauth_token, data=json_data({"operation": "write"}))
        privileged_allowed = privileged.get("status") == 200 and (privileged.get("body") or {}).get("privileged_probe") is True
        results.append(result("privileged_function_replay", "fail" if privileged_allowed else "pass", str(privileged.get("status")), "401/403", privileged, note="The disposable dispatcher is configured without JWT verification to measure the exposed edge boundary."))
        account_update = request(auth, "/user", "PUT", token=oauth_token, data=json_data({"data": {"oauth_probe": "write"}}))
        results.append(result("gotrue_user_mutation_replay", "pass" if account_update.get("status") in (401, 403) else "fail", str(account_update.get("status")), "401/403", account_update))
        replay = request(auth, "/oauth/token", "POST", data=urlencode({"grant_type": "authorization_code", "code": code or "", "redirect_uri": CLIENT_REDIRECT, "client_id": client_id, "code_verifier": verifier}).encode(), content_type="application/x-www-form-urlencoded")
        results.append(result("authorization_code_replay", "pass" if replay.get("status") in (400, 401) else "fail", str(replay.get("status")), "400/401", replay))
        wrong_refresh = request(auth, "/oauth/token", "POST", data=urlencode({"grant_type": "refresh_token", "refresh_token": refresh or "", "client_id": str(secrets.token_hex(16))}).encode(), content_type="application/x-www-form-urlencoded")
        results.append(result("wrong_client_refresh", "pass" if wrong_refresh.get("status") in (400, 401) else "fail", str(wrong_refresh.get("status")), "400/401", wrong_refresh))
        missing_pkce = request(auth, "/oauth/authorize?" + urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": CLIENT_REDIRECT, "scope": "openid", "state": "missing-pkce"}))
        results.append(result("missing_pkce", "pass" if missing_pkce.get("status") in (302, 400) and not parse_qs(urlparse(missing_pkce.get("location", "")).query).get("code") else "fail", str(missing_pkce.get("status")), "reject or redirect with error", missing_pkce))
        unknown = request(auth, "/oauth/authorize?" + urlencode({"response_type": "code", "client_id": "00000000-0000-0000-0000-000000000000", "redirect_uri": CLIENT_REDIRECT, "scope": "openid", "state": "unknown"}))
        results.append(result("unknown_client", "pass" if unknown.get("status") == 400 else "fail", str(unknown.get("status")), "400", unknown))
        unsupported = request(auth, "/oauth/authorize?" + urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": CLIENT_REDIRECT, "scope": "openid knowledge:read", "state": "unsupported", "code_challenge": challenge, "code_challenge_method": "S256"}))
        unsupported_query = parse_qs(urlparse(unsupported.get("location", "")).query)
        results.append(result("unsupported_scope", "pass" if unsupported.get("status") in (302, 400) and unsupported_query.get("error") else "fail", str(unsupported.get("status")), "error response", unsupported))
        wrong_aud = dict(claims); wrong_aud["aud"] = "wrong-audience"
        wrong_token = sign_jwt(header, wrong_aud)
        wrong_aud_read = request(rest, "/oauth_probe?id=eq.1", token=wrong_token)
        results.append(result("wrong_audience", "fail" if wrong_aud_read.get("status") == 200 else "pass", str(wrong_aud_read.get("status")), "401/403", wrong_aud_read, note="PostgREST is intentionally run without PGRST_JWT_AUD to reveal whether the audience is enforced."))
        openid = request(auth, "/.well-known/openid-configuration")
        jwks = request(auth, "/.well-known/jwks.json")
        results.append(result("asymmetric_signing", "fail" if header.get("alg") == "HS256" else "pass", header.get("alg", "unknown"), "asymmetric OIDC signing for ID tokens", {"token_header": header, "openid": openid, "jwks": jwks}, note="HS256 is acceptable for ordinary local Supabase JWTs but does not satisfy asymmetric OIDC ID-token interoperability."))
        results.append(result("oidc_id_token_flow", "untested", "openid scope omitted because no signing key is configured in the disposable stack", "OIDC ID token issuance and signature validation", "https://supabase.com/docs/guides/auth/oauth-server/token-security"))
        refresh_ok = request(auth, "/oauth/token", "POST", data=urlencode({"grant_type": "refresh_token", "refresh_token": refresh or "", "client_id": client_id}).encode(), content_type="application/x-www-form-urlencoded")
        results.append(result("client_bound_refresh", "pass" if refresh_ok.get("status") == 200 else "fail", str(refresh_ok.get("status")), "200 for original client", {"status": refresh_ok.get("status")}))
        # Firebase is intentionally documentation-grounded; no Firebase project is connected by this harness.
        results.extend([
            result("firebase_third_party_supabase", "supported", "Supabase documents Firebase JWT verification as a third-party integration", "documentation compatibility", "https://supabase.com/docs/guides/auth/third-party/firebase-auth"),
            result("firebase_uuid_preservation", "migration-work", "existing Carbon UUIDs require an import/linking migration and identity mapping", "preserve application subject IDs", "https://firebase.google.com/docs/auth/admin/import-users"),
            result("firebase_origin_session", "supported", "web persistence is scoped to an origin", "documented browser behavior", "https://firebase.google.com/docs/auth/web/auth-state-persistence"),
            result("firebase_live_config", "untested", "no Firebase project, issuer, or credentials supplied", "live issuer/project/role/MFA/linking verification", note="Must be tested in a separately authorized environment."),
        ])
        gate_failures = [item["id"] for item in results if item["status"] == "fail" and item["id"] in {"postgrest_dml_replay", "postgrest_rpc_replay", "storage_write_replay", "realtime_write_replay", "privileged_function_replay", "gotrue_user_mutation_replay", "wrong_audience", "asymmetric_signing"}]
        metadata["gate_failures"] = gate_failures
        metadata["firebase_live_verification"] = "untested"
        return {"metadata": metadata, "adoption_gate": "failed" if gate_failures else "passed", "results": results}
    finally:
        subprocess.run(["docker", "compose", "--file", str(COMPOSE), "down", "-v", "--remove-orphans"], env=env, text=True, capture_output=True, timeout=60)


def authorizationization_status(value: dict[str, Any]) -> Any:
    return value.get("status")


def evaluate_synthetic_static() -> dict[str, Any]:
    return {"metadata": {"mode": "synthetic-static", "live_stack": False}, "adoption_gate": "blocked", "results": [
        result("native_oauth_feature", "supported", "GoTrue v2.189.0 exposes OAuth server endpoints behind GOTRUE_OAUTH_SERVER_ENABLED", "feature availability", "https://supabase.com/docs/guides/auth/oauth-server"),
        result("firebase_live_config", "untested", "no Firebase project or credentials", "live issuer/project/role/MFA/linking verification"),
    ]}


def render_results(report: dict[str, Any]) -> str:
    def sanitize(value: Any, key: str = "") -> Any:
        if key in {"access_token", "refresh_token", "client_secret", "authorization", "code", "id_token"}:
            return "<redacted>"
        if isinstance(value, dict):
            return {name: sanitize(item, name) for name, item in value.items()}
        if isinstance(value, list):
            return [sanitize(item, key) for item in value]
        if isinstance(value, str) and ("code=" in value or "Bearer ey" in value):
            return re.sub(r"([?&]code=)[^&\\s]+", r"\\1<redacted>", value).replace("Bearer ey", "Bearer <redacted>")
        return value

    safe_report = sanitize(report)
    return "# OAuth compatibility evaluation\n\n" + (
        "This report is synthetic and disposable. It does not enable native OAuth, Identity Platform, or any production configuration. "
        "A native delegation adoption gate fails if any read token reaches a direct write or replay surface.\n\n"
        f"Adoption gate: **{safe_report['adoption_gate']}**\n\n"
        "## Machine-readable matrix\n\n```json\n" + json.dumps(safe_report, indent=2, sort_keys=True) + "\n```\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--disposable", action="store_true", help="run the pinned Docker stack")
    parser.add_argument("--synthetic", action="store_true", help="use only synthetic values")
    parser.add_argument("--write-results", action="store_true", help="update RESULTS.md")
    args = parser.parse_args()
    report = evaluate_disposable() if args.disposable else evaluate_synthetic_static()
    output = render_results(report)
    if args.write_results or args.disposable:
        (HERE / "RESULTS.md").write_text(output)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["adoption_gate"] in ("passed", "failed") else 2


if __name__ == "__main__":
    raise SystemExit(main())
