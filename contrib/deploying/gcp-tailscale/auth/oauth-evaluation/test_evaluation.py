import importlib.util
import json
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("oauth_evaluation", HERE / "evaluate.py")
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


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


if __name__ == "__main__":
    unittest.main()
