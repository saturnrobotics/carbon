"""The ERP portal receiver's inputs: private, ERP-only, validated fail-closed."""

import json
from pathlib import Path
import tempfile
import unittest

import portal_receiver
from deploy import validate
from render import render
from test_deploy import fixture, SECRETS

HERE = Path(__file__).resolve().parent
AUDIENCE = "https://erp.hq.example.com"


def caller(subject="synthetic-subject-1"):
    return {"callerId": "portal-query", "serviceAccountSubject": subject, "sourceIapAudience": "/projects/0/global/backendServices/0",
            "operations": ["portal_resolveItems"], "capabilities": ["portal.read"], "requiredAccessLevels": []}


def registry(audience=AUDIENCE, callers=None, **overrides):
    value = {"version": 1, "receiver": {"id": "carbon-erp", "audience": audience}, "callers": [caller()] if callers is None else callers}
    value.update(overrides)
    return json.dumps(value)


class PortalReceiverTests(unittest.TestCase):
    def test_direct_renderer_rejects_legacy_keys_instead_of_disabling_receiver(self):
        for key in ("KNOWLEDGE_RECEIVER_AUDIENCE", "KNOWLEDGE_TRUSTED_CALLERS_JSON"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "legacy.*Portal"):
                portal_receiver.validate({key: "synthetic-private-value"})

    def test_example_inputs_validate_with_the_audience_alone(self):
        # The example config names the audience; the secret stays optional until enrolled.
        self.assertEqual(fixture()["PORTAL_RECEIVER_AUDIENCE"], AUDIENCE)
        validate(fixture(), SECRETS)
        portal_receiver.validate({"PORTAL_RECEIVER_AUDIENCE": AUDIENCE})
        portal_receiver.validate({})

    def test_registry_requires_the_matching_reviewable_audience(self):
        config = fixture()
        del config["PORTAL_RECEIVER_AUDIENCE"]
        with self.assertRaisesRegex(ValueError, "PORTAL_RECEIVER_AUDIENCE"):
            validate(config, {**SECRETS, "PORTAL_TRUSTED_CALLERS_JSON": registry()})
        with self.assertRaisesRegex(ValueError, "must equal"):
            validate(fixture(), {**SECRETS, "PORTAL_TRUSTED_CALLERS_JSON": registry(audience="https://other.example.com")})
        for audience in ("http://erp.hq.example.com", "erp.hq.example.com", "https://erp.hq.example.com { respond 200 }", 5):
            with self.subTest(audience=audience), self.assertRaisesRegex(ValueError, "PORTAL_RECEIVER_AUDIENCE"):
                validate({**fixture(), "PORTAL_RECEIVER_AUDIENCE": audience}, SECRETS)
        validate(fixture(), {**SECRETS, "PORTAL_TRUSTED_CALLERS_JSON": registry()})

    def test_example_placeholder_is_refused_rather_than_deployed(self):
        placeholder = json.loads((HERE / "secrets.example.json").read_text())["PORTAL_TRUSTED_CALLERS_JSON"]
        with self.assertRaisesRegex(ValueError, "placeholder"):
            validate(fixture(), {**SECRETS, "PORTAL_TRUSTED_CALLERS_JSON": placeholder})

    def test_malformed_registries_fail_without_echoing_their_contents(self):
        cases = {
            "not json": "secret-value-not-json",
            "empty object": "{}",
            "wrong version": registry(version=2),
            "no callers": registry(callers=[]),
            "duplicate subjects": registry(callers=[caller(), caller()]),
            "extra caller key": registry(callers=[{**caller(), "email": "person@example.com"}]),
            "missing caller key": registry(callers=[{k: v for k, v in caller().items() if k != "capabilities"}]),
            "no operations": registry(callers=[{**caller(), "operations": []}]),
            "extra receiver key": json.dumps({**json.loads(registry()), "receiver": {"id": "x", "audience": AUDIENCE, "extra": 1}}),
            "multi-line": registry().replace(",", ",\n", 1),
            "blank receiver id": json.dumps({**json.loads(registry()), "receiver": {"id": " ", "audience": AUDIENCE}}),
        }
        for name, value in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(ValueError) as raised:
                    portal_receiver.validate({"PORTAL_RECEIVER_AUDIENCE": AUDIENCE, "PORTAL_TRUSTED_CALLERS_JSON": value})
                self.assertNotIn("synthetic-subject-1", str(raised.exception))
                self.assertNotIn("secret-value", str(raised.exception))

    def test_only_erp_receives_the_registry_and_removal_does_not_resurrect_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            output = state / "rendered"
            config = {**fixture(), **SECRETS, "TAILSCALE_IP": "100.72.10.8", "DEPLOY_REVISION": "a" * 40,
                      "SOURCE_CODE_URL": "https://github.com/example/carbon/tree/" + "a" * 40,
                      "PORTAL_TRUSTED_CALLERS_JSON": registry()}
            render(config, HERE.parents[2], output, state)
            content = (output / "compose.json").read_text()
            self.assertNotIn("synthetic-subject-1", content)
            stack = json.loads(content)
            erp = stack["services"]["erp"]
            self.assertEqual(erp["environment"]["PORTAL_RECEIVER_AUDIENCE"], AUDIENCE)
            self.assertEqual(erp["environment"]["PORTAL_TRUSTED_CALLERS_JSON"], "__PORTAL_TRUSTED_CALLERS_JSON__")
            self.assertIn("portal_trusted_callers_json", erp["secrets"])
            secret = state / "secrets/portal_trusted_callers_json"
            self.assertEqual(stack["secrets"]["portal_trusted_callers_json"], {"file": str(secret)})
            self.assertEqual(secret.read_text(), registry())
            self.assertEqual(secret.stat().st_mode & 0o777, 0o444)
            for name, service in stack["services"].items():
                if name != "erp":
                    self.assertNotIn("portal_trusted_callers_json", service.get("secrets", []))
                    self.assertNotIn("PORTAL_TRUSTED_CALLERS_JSON", service.get("environment", {}))
                    self.assertNotIn("PORTAL_RECEIVER_AUDIENCE", service.get("environment", {}))
            del config["PORTAL_TRUSTED_CALLERS_JSON"]
            del config["PORTAL_RECEIVER_AUDIENCE"]
            render(config, HERE.parents[2], output, state)
            stack = json.loads((output / "compose.json").read_text())
            erp = stack["services"]["erp"]
            self.assertEqual(erp["environment"]["PORTAL_TRUSTED_CALLERS_JSON"], "")
            self.assertEqual(erp["environment"]["PORTAL_RECEIVER_AUDIENCE"], "")
            self.assertNotIn("portal_trusted_callers_json", erp["secrets"])
            self.assertNotIn("portal_trusted_callers_json", stack["secrets"])


if __name__ == "__main__":
    unittest.main()
