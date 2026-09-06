import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import payment_sync
from render import render
from test_deploy import fixture, SECRETS
from deploy import validate

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("gmail_connect", HERE / "gmail-connect.py")
connect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connect)


def account(email="billing@example.com"):
    return {"email": email, "clientId": "synthetic-client", "clientSecret": "synthetic-secret", "refreshToken": "synthetic-refresh", "enabled": True}


class PaymentSyncTests(unittest.TestCase):
    def test_optional_credentials_need_company_binding(self):
        for company in (None, False, 0):
            with self.assertRaisesRegex(ValueError, "PAYMENT_SYNC_COMPANY_ID"):
                payment_sync.validate({"PAYMENT_SYNC_COMPANY_ID": company})
        with self.assertRaisesRegex(ValueError, "PAYMENT_SYNC_COMPANY_ID"):
            validate(fixture(), {**SECRETS, "MERCURY_API_TOKEN": "synthetic-token"})
        validate({**fixture(), "PAYMENT_SYNC_COMPANY_ID": "co_example"}, {**SECRETS, "MERCURY_API_TOKEN": "synthetic-token", "GMAIL_ACCOUNTS_JSON": json.dumps([account()])})

    def test_invalid_accounts_fail_without_echoing_credentials(self):
        for value in ("secret-value-not-json", "{}", json.dumps([account(), account()]), json.dumps([{**account(), "enabled": "yes"}]), json.dumps([{**account(), "refreshToken": "secret\nvalue"}])):
            with self.subTest(value=value):
                with self.assertRaises(ValueError) as raised:
                    payment_sync.validate({"PAYMENT_SYNC_COMPANY_ID": "co_example", "GMAIL_ACCOUNTS_JSON": value})
                self.assertNotIn("synthetic-secret", str(raised.exception))
                self.assertNotIn("secret-value", str(raised.exception))

    def test_only_erp_gets_secrets_and_omission_disables_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            output = state / "rendered"
            config = {**fixture(), **SECRETS, "TAILSCALE_IP": "100.72.10.8", "DEPLOY_REVISION": "a" * 40, "SOURCE_CODE_URL": "https://github.com/example/carbon/tree/" + "a" * 40,
                      "PAYMENT_SYNC_COMPANY_ID": "co_example", "MERCURY_API_TOKEN": "synthetic-bank-token", "GMAIL_ACCOUNTS_JSON": json.dumps([account()])}
            render(config, HERE.parents[2], output, state)
            content = (output / "compose.json").read_text()
            self.assertNotIn("synthetic-bank-token", content)
            self.assertNotIn("synthetic-refresh", content)
            stack = json.loads(content)
            for name, service in stack["services"].items():
                if name != "erp":
                    self.assertNotIn("gmail_accounts_json", service.get("secrets", []))
                    self.assertNotIn("mercury_api_token", service.get("secrets", []))
            self.assertIn("gmail_accounts_json", stack["services"]["erp"]["secrets"])
            config.pop("MERCURY_API_TOKEN")
            config.pop("GMAIL_ACCOUNTS_JSON")
            render(config, HERE.parents[2], output, state)
            stack = json.loads((output / "compose.json").read_text())
            self.assertEqual(stack["services"]["erp"]["environment"]["MERCURY_API_TOKEN"], "")
            self.assertNotIn("gmail_accounts_json", stack["services"]["erp"]["secrets"])

    def test_mailbox_reconnect_preserves_other_secrets_and_accounts(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "secrets.json"
            values = {"MERCURY_API_TOKEN": "synthetic-bank", "GMAIL_ACCOUNTS_JSON": json.dumps([account(), account("other@example.com")])}
            connect.save_account(path, values, {**account(), "refreshToken": "replacement"})
            saved = json.loads(path.read_text())
            mailboxes = json.loads(saved["GMAIL_ACCOUNTS_JSON"])
            self.assertEqual(len(mailboxes), 2)
            self.assertEqual(saved["MERCURY_API_TOKEN"], "synthetic-bank")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(next(a for a in mailboxes if a["email"] == "billing@example.com")["refreshToken"], "replacement")


if __name__ == "__main__":
    unittest.main()
