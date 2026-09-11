import importlib.util
import json
from pathlib import Path
import re
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("oauth_evaluation", HERE / "evaluate.py")
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

CLOSED = {"status": None, "error": "Remote end closed connection without response"}
STORAGE_DENIED = {"status": 400, "body": {"statusCode": "403", "error": "Unauthorized", "message": "new row violates row-level security policy"}}
OBJECT_MISSING = {"status": 400, "body": {"statusCode": "404", "error": "not_found", "message": "Object not found"}}
OBJECT_PRESENT = {"status": 200, "body": {"name": "replayed.txt", "bucket_id": "evaluation"}}


class OAuthEvaluationBehaviorTests(unittest.TestCase):
    def test_compose_pins_consumers_and_bounded_state(self):
        compose = (HERE / "compose.yml").read_text()
        self.assertIn("supabase/gotrue:v2.189.0", compose)
        self.assertIn("postgrest/postgrest:v13.0.8", compose)
        self.assertIn("supabase/storage-api:v1.58.4", compose)
        self.assertIn("supabase/realtime:v2.89.0", compose)
        self.assertIn("supabase/edge-runtime:v1.74.0", compose)
        self.assertIn("/var/lib/postgresql/data:size=768m", compose)
        self.assertNotIn("pgdata:", compose)

    def test_compose_makes_storage_and_realtime_observable(self):
        compose = (HERE / "compose.yml").read_text()
        self.assertIn("http://127.0.0.1:5000/status", compose, "storage needs a healthcheck so the probe waits for it")
        self.assertIn("http://127.0.0.1:4000/healthcheck", compose, "realtime needs a healthcheck so the probe waits for it")
        self.assertIn("storage-init:", compose)
        self.assertIn("condition: service_healthy", compose.split("storage-init:", 1)[1].split("realtime:", 1)[0])
        self.assertIn(f"'{module.STORAGE_DENIED_BUCKET}'", compose)
        self.assertIn(f"'{module.STORAGE_GRANTED_BUCKET}'", compose)
        self.assertIn(f"WITH CHECK (bucket_id = '{module.STORAGE_GRANTED_BUCKET}')", compose)
        self.assertIn("- realtime-dev", compose)
        self.assertEqual(module.REALTIME_TENANT_HOST.split(".", 1)[0], "realtime-dev")

    def test_compose_shares_one_synthetic_jwt_secret_across_consumers(self):
        compose = (HERE / "compose.yml").read_text()
        for variable in ("GOTRUE_JWT_SECRET", "PGRST_JWT_SECRET", "API_JWT_SECRET", "JWT_SECRET"):
            values = set(re.findall(rf"^\s+{variable}: (.+)$", compose, flags=re.MULTILINE))
            self.assertEqual(values, {module.JWT_SECRET}, variable)

    def test_pkce_challenge_is_s256_and_code_verifier_changes_signature(self):
        verifier = "synthetic-code-verifier"
        challenge = module.base64.urlsafe_b64encode(module.hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        self.assertEqual(len(challenge), 43)
        self.assertNotEqual(challenge, verifier)

    def test_jwt_audience_replay_is_behaviorally_detectable(self):
        token = module.sign_jwt({"alg": "HS256", "typ": "JWT"}, {"sub": "synthetic", "aud": "authenticated", "role": "authenticated"})
        header, claims = module.decode_jwt(token)
        self.assertEqual(header["alg"], "HS256")
        self.assertEqual(claims["aud"], "authenticated")
        forged = module.sign_jwt(header, {**claims, "aud": "wrong-audience"})
        _forged_header, forged_claims = module.decode_jwt(forged)
        self.assertEqual(forged_claims["aud"], "wrong-audience")
        self.assertNotEqual(token, forged)

    def test_unreachable_storage_write_is_a_distinct_failure(self):
        item = module.classify_storage_write("storage_write_replay", CLOSED, CLOSED)
        self.assertEqual(item["status"], "fail")
        self.assertTrue(item["observed"].startswith("unreachable: Remote end closed"))
        self.assertNotEqual(item["status"], "untested")
        self.assertIn("never as untested", item["note"])

    def test_unreachable_realtime_write_is_a_distinct_failure(self):
        item = module.classify_realtime_write("realtime_write_replay", CLOSED)
        self.assertEqual(item["status"], "fail")
        self.assertTrue(item["observed"].startswith("unreachable: Remote end closed"))
        self.assertNotEqual(item["status"], "untested")

    def test_storage_denial_requires_denied_status_and_absent_object(self):
        denied = module.classify_storage_write("storage_write_replay", STORAGE_DENIED, OBJECT_MISSING)
        self.assertEqual(denied["status"], "pass")
        self.assertEqual(denied["observed"], "http=400 body.statusCode=403 object_written=false")
        self.assertEqual(module.classify_storage_write("x", {"status": 403, "body": ""}, OBJECT_MISSING)["status"], "pass")
        self.assertEqual(module.classify_storage_write("x", STORAGE_DENIED, OBJECT_PRESENT)["status"], "fail")
        written = module.classify_storage_write("storage_write_replay_granted_policy", {"status": 200, "body": {"Key": "evaluation-granted/replayed.txt"}}, OBJECT_PRESENT)
        self.assertEqual(written["status"], "fail")
        self.assertEqual(written["observed"], "http=200 body.statusCode=none object_written=true")
        self.assertEqual(module.classify_storage_write("x", OBJECT_MISSING, OBJECT_MISSING)["status"], "fail", "a missing bucket is not a denial")

    def test_realtime_accepted_or_unsupported_broadcast_is_not_a_denial(self):
        self.assertEqual(module.classify_realtime_write("x", {"status": 401, "body": {"message": "Unauthorized"}})["status"], "pass")
        accepted = module.classify_realtime_write("x", {"status": 202, "body": None}, controls={"no_token": {"status": 401}})
        self.assertEqual(accepted["status"], "fail")
        self.assertEqual(accepted["observed"], "http=202")
        self.assertEqual(accepted["evidence"]["controls"]["no_token"]["status"], 401)
        self.assertEqual(module.classify_realtime_write("x", {"status": 404, "body": "not found"})["status"], "fail")

    def test_storage_and_realtime_replays_are_gate_checks(self):
        for name in ("storage_write_replay", "storage_write_replay_granted_policy", "realtime_write_replay"):
            self.assertIn(name, module.GATE_IDS)
        for name in ("storage_health", "realtime_health", "storage_fixture", "gotrue_health"):
            self.assertNotIn(name, module.GATE_IDS)

    def test_matrix_has_security_gate_and_firebase_unknowns(self):
        report = module.evaluate_synthetic_static()
        self.assertEqual(report["adoption_gate"], "blocked")
        ids = {item["id"] for item in report["results"]}
        self.assertIn("native_oauth_feature", ids)
        self.assertIn("firebase_live_config", ids)
        self.assertTrue(any(item["status"] == "untested" for item in report["results"]))

    def test_result_json_is_machine_readable(self):
        report = {"metadata": {"mode": "test"}, "adoption_gate": "failed", "results": [{"id": "token", "access_token": "synthetic-secret"}]}
        rendered = module.render_results(report)
        payload = rendered.split("```json\n", 1)[1].split("\n```", 1)[0]
        self.assertEqual(json.loads(payload)["adoption_gate"], "failed")
        self.assertNotIn("synthetic-secret", rendered)

    def test_rendered_results_redact_authorization_codes_in_urls(self):
        report = {"metadata": {}, "adoption_gate": "failed", "results": [{"id": "pkce", "evidence": {"redirect_url": "http://127.0.0.1:18994/callback?code=synthetic-code&state=s"}}]}
        rendered = module.render_results(report)
        self.assertNotIn("synthetic-code", rendered)
        self.assertNotIn("\\1", rendered)
        self.assertIn("callback?code=<redacted>&state=s", rendered)


if __name__ == "__main__":
    unittest.main()
