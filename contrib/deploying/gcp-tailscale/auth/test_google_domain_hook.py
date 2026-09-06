"""Exercise the real hook SQL in an isolated, temporary PostgreSQL cluster.

Requires PostgreSQL's initdb, pg_ctl and psql on PATH. Never connects to an
existing database, uses no application data, and deletes the cluster afterward.
"""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


DIRECTORY = Path(__file__).resolve().parent
USER_ID = "10000000-0000-0000-0000-000000000001"
EMAIL = "employee@example.com"
CLAIMS = {
    "sub": USER_ID,
    "email": EMAIL,
    "role": "authenticated",
    "is_anonymous": False,
    "amr": [{"method": "oauth", "timestamp": 1234567890}],
    "custom_application_claim": {"keep": True},
}
IDENTITY = {
    "email": EMAIL,
    "email_verified": True,
    "custom_claims": {"hd": "example.com"},
}


def literal(value):
    if not isinstance(value, str):
        value = json.dumps(value)
    return "'" + value.replace("'", "''") + "'"


class GoogleDomainHookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for binary in ("initdb", "pg_ctl", "psql"):
            if not shutil.which(binary):
                raise RuntimeError(f"Install PostgreSQL and add {binary} to PATH")
        # Keep the socket path below Unix's ~104-byte sockaddr limit on macOS.
        cls.temporary = tempfile.TemporaryDirectory(prefix="carbon-auth-", dir="/tmp")
        cls.cluster = Path(cls.temporary.name)
        cls.environment = {
            key: value for key, value in os.environ.items() if not key.startswith("PG")
        }
        cls.environment["LC_ALL"] = "C"
        cls.started = False
        try:
            cls.command(
                "initdb", "-D", str(cls.cluster / "data"), "-U", "postgres",
                "--auth-local=trust", "--auth-host=reject", "--no-locale",
            )
            cls.command(
                "pg_ctl", "-D", str(cls.cluster / "data"),
                "-l", str(cls.cluster / "postgres.log"), "-w", "start",
                "-o", f"-k {cls.cluster} -c listen_addresses='' -c fsync=off",
            )
            cls.started = True
            cls.sql("""
                CREATE ROLE anon;
                CREATE ROLE authenticated;
                CREATE ROLE supabase_auth_admin;
                CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
                CREATE TABLE auth.users (
                  id UUID PRIMARY KEY,
                  email TEXT,
                  email_confirmed_at TIMESTAMPTZ,
                  raw_user_meta_data JSONB
                );
                CREATE TABLE auth.identities (
                  user_id UUID,
                  provider TEXT,
                  identity_data JSONB
                );
                GRANT SELECT ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
            """)
            cls.install()
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def command(cls, *arguments, input=None, check=True):
        result = subprocess.run(
            arguments, input=input, text=True, capture_output=True,
            env=cls.environment, timeout=60,
        )
        if check and result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return result

    @classmethod
    def sql(cls, statement, *arguments, check=True):
        return cls.command(
            "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
            "-h", str(cls.cluster), "-p", "5432", "-U", "postgres",
            "-d", "postgres", *arguments, input=statement, check=check,
        )

    @classmethod
    def install(cls, domain="example.com"):
        return cls.sql(
            (DIRECTORY / "google-domain-hook.sql").read_text(),
            "-v", f"allowed_email_domain={domain}",
        )

    @classmethod
    def tearDownClass(cls):
        if cls.started:
            cls.command(
                "pg_ctl", "-D", str(cls.cluster / "data"),
                "-m", "immediate", "-w", "stop", check=False,
            )
        cls.temporary.cleanup()

    def setUp(self):
        self.sql("""
            TRUNCATE auth.users, auth.identities;
            INSERT INTO carbon_private.auth_policy VALUES (TRUE, 'example.com')
            ON CONFLICT (singleton) DO UPDATE SET allowed_email_domain = 'example.com';
        """)
        self.sql(f"""
            INSERT INTO auth.users VALUES (
              {literal(USER_ID)}, {literal(EMAIL)}, CURRENT_TIMESTAMP,
              '{{"email_verified":true,"custom_claims":{{"hd":"example.com"}}}}'
            );
            INSERT INTO auth.identities VALUES (
              {literal(USER_ID)}, 'google', {literal(IDENTITY)}::JSONB
            );
        """)

    def hook(self, method="oauth", claims=None, user_id=USER_ID):
        event = {
            "user_id": user_id,
            "authentication_method": method,
            "claims": CLAIMS if claims is None else claims,
        }
        result = self.sql(
            "SET ROLE supabase_auth_admin; SELECT "
            f"carbon_private.google_domain_access_token({literal(event)}::JSONB);"
        )
        return json.loads(result.stdout)

    def assert_denied(self, **kwargs):
        result = self.hook(**kwargs)
        self.assertEqual(result.get("error", {}).get("http_code"), 403, result)
        self.assertNotIn("claims", result)

    def set_identity(self, identity):
        self.sql(f"UPDATE auth.identities SET identity_data = {literal(identity)}::JSONB;")

    def test_google_oauth_refresh_and_mfa_preserve_all_claims(self):
        for method in ("oauth", "token_refresh", "totp"):
            with self.subTest(method=method):
                self.assertEqual(self.hook(method=method), {"claims": CLAIMS})

    def test_password_magiclink_invite_anonymous_and_unknown_are_rejected(self):
        for method in (
            "password", "magiclink", "invite", "anonymous", "sso/saml", "otp",
            "email/signup", "email_change", "recovery", "", None, "future_method",
        ):
            with self.subTest(method=method):
                self.assert_denied(method=method)

    def test_refresh_requires_original_oauth_authentication(self):
        for amr in (None, {}, [], [{"method": "password"}], [{"method": "totp"}]):
            with self.subTest(amr=amr):
                claims = {**CLAIMS, "amr": amr}
                self.assert_denied(method="token_refresh", claims=claims)

    def test_rejects_non_google_identity(self):
        self.sql("UPDATE auth.identities SET provider = 'azure';")
        self.assert_denied()

    def test_rejects_missing_google_identity_even_with_user_metadata(self):
        self.sql("DELETE FROM auth.identities;")
        self.assert_denied()

    def test_requires_boolean_verified_google_email(self):
        for verified in (False, "true", None):
            with self.subTest(verified=verified):
                self.set_identity({**IDENTITY, "email_verified": verified})
                self.assert_denied()

    def test_rejects_consumer_account_missing_signed_hosted_domain(self):
        self.set_identity({"email": EMAIL, "email_verified": True})
        self.assert_denied()

    def test_rejects_different_workspace(self):
        self.set_identity({**IDENTITY, "custom_claims": {"hd": "other.example"}})
        self.assert_denied()

    def test_rejects_wrong_email_domain_suffix_subdomain_and_malformed_address(self):
        for email in (
            "employee@other.example", "employee@badexample.com",
            "employee@example.com.bad", "employee@sub.example.com",
            "employee@example.com@other.example", "@example.com",
        ):
            with self.subTest(email=email):
                self.sql(f"UPDATE auth.users SET email = {literal(email)};")
                self.set_identity({**IDENTITY, "email": email})
                self.assert_denied(claims={**CLAIMS, "email": email})

    def test_identity_email_must_match_account(self):
        self.set_identity({**IDENTITY, "email": "someone.else@example.com"})
        self.assert_denied()

    def test_claim_email_must_match_account(self):
        self.assert_denied(claims={**CLAIMS, "email": "someone.else@example.com"})

    def test_user_id_must_match_claim_subject(self):
        self.assert_denied(user_id="10000000-0000-0000-0000-000000000002")

    def test_rejects_unconfirmed_account(self):
        self.sql("UPDATE auth.users SET email_confirmed_at = NULL;")
        self.assert_denied()

    def test_rejects_anonymous_or_privileged_claims(self):
        self.assert_denied(claims={**CLAIMS, "is_anonymous": True})
        self.assert_denied(claims={**CLAIMS, "role": "service_role"})

    def test_missing_policy_fails_closed(self):
        self.sql("DELETE FROM carbon_private.auth_policy;")
        self.assert_denied()

    def test_domain_change_applies_on_refresh(self):
        self.sql("UPDATE carbon_private.auth_policy SET allowed_email_domain = 'other.example';")
        self.assert_denied(method="token_refresh")

    def test_normalizes_email_and_hosted_domain_case(self):
        self.sql("UPDATE auth.users SET email = 'Employee@EXAMPLE.COM';")
        identity = copy.deepcopy(IDENTITY)
        identity["email"] = "EMPLOYEE@example.com"
        identity["custom_claims"]["hd"] = "EXAMPLE.COM"
        self.set_identity(identity)
        self.assertEqual(self.hook(), {"claims": CLAIMS})

    def test_install_is_repeatable_and_domain_value_is_sql_escaped(self):
        self.install()
        self.install("EXAMPLE.COM")
        self.assertEqual(self.hook(), {"claims": CLAIMS})
        with self.assertRaises(AssertionError):
            self.install("example.com'); DROP SCHEMA auth CASCADE; --")
        self.assertEqual(self.hook(), {"claims": CLAIMS})

    def test_client_roles_cannot_call_hook_or_change_policy(self):
        for role in ("anon", "authenticated"):
            for query in (
                "SELECT carbon_private.google_domain_access_token('{}');",
                "SELECT * FROM carbon_private.auth_policy;",
                "UPDATE carbon_private.auth_policy SET allowed_email_domain = 'other.example';",
            ):
                with self.subTest(role=role, query=query):
                    result = self.sql(f"SET ROLE {role}; {query}", check=False)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("permission denied", result.stderr)
        result = self.sql(
            "SET ROLE supabase_auth_admin; "
            "UPDATE carbon_private.auth_policy SET allowed_email_domain = 'other.example';",
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("permission denied", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
