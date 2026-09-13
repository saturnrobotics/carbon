"""Workforce identity enrollment proofs through real database roles.

Every case runs against the labelled disposable fixture and rolls back its own
writes. Synthetic subjects use the IAP shape with reserved numeric ids.
"""
import json
import unittest
from pathlib import Path

from test_schema import sql

ISSUER = "https://cloud.google.com/iap"
ENROLL = "portal.enroll_workforce_identity"
UNBIND = "portal.unbind_workforce_identity"
ENROLL_SIGNATURE = f"{ENROLL}(text,text,text,text,text[])"
UNBIND_SIGNATURE = f"{UNBIND}(text,text,text)"
RUNTIME_ROLES = (
    "portal_read",
    "portal_ingest",
    "portal_review",
    "portal_actions",
    "portal_maintenance",
)


def enroll(subject, company, user, capabilities="ARRAY['portal.read']"):
    # Fixed synthetic values only; never production input.
    return f"SELECT {ENROLL}('{ISSUER}','{subject}','{company}','{user}',{capabilities}::text[])"


def unbind(subject, company):
    return f"SELECT {UNBIND}('{ISSUER}','{subject}','{company}')"


def as_migrator(*statements):
    body = "; ".join(statements)
    return f"BEGIN; SET LOCAL ROLE portal_migrate; {body}; ROLLBACK"


def json_lines(output):
    return [json.loads(line) for line in output.splitlines() if line.startswith("{")]


class EnrollmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql(Path(__file__).with_name("policy-fixtures.sql").read_text())

    def test_owner_role_is_nologin_and_functions_expose_no_public_execute(self):
        self.assertEqual(
            sql(
                "SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit "
                "FROM pg_roles WHERE rolname='portal_enrollment_owner'"
            ),
            "t",
        )
        for signature in (ENROLL_SIGNATURE, UNBIND_SIGNATURE):
            with self.subTest(function=signature):
                self.assertEqual(
                    sql(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='{signature}'::regprocedure"),
                    "portal_enrollment_owner",
                )
                self.assertEqual(
                    sql(
                        "SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a "
                        f"WHERE p.oid='{signature}'::regprocedure AND a.grantee=0)"
                    ),
                    "f",
                )
                self.assertEqual(
                    sql(f"SELECT has_function_privilege('portal_migrate','{signature}','EXECUTE')"),
                    "t",
                )
        self.assertEqual(
            sql("SELECT pg_has_role('portal_migrate','portal_enrollment_owner','member')"),
            "f",
        )

    def test_runtime_and_browser_roles_cannot_execute_either_function(self):
        for role in RUNTIME_ROLES + ("anon", "authenticated"):
            with self.subTest(role=role):
                sql(
                    f"BEGIN; SET LOCAL ROLE {role}; {enroll('accounts.google.com:100000000000000000901', 'company-a', 'alice')}; ROLLBACK",
                    succeeds=False,
                    sqlstate="42501",
                )
                sql(
                    f"BEGIN; SET LOCAL ROLE {role}; {unbind('accounts.google.com:100000000000000000901', 'company-a')}; ROLLBACK",
                    succeeds=False,
                    sqlstate="42501",
                )

    def test_runtime_write_policies_on_bindings_stay_closed(self):
        for role in ("portal_ingest", "portal_review", "portal_actions"):
            with self.subTest(role=role):
                sql(
                    f"BEGIN; SET LOCAL ROLE {role}; INSERT INTO portal.\"identityBinding\"(\"companyId\",\"createdBy\",issuer,subject,\"canonicalUserId\") "
                    "VALUES ('company-a','alice','x','accounts.google.com:1','alice'); ROLLBACK",
                    succeeds=False,
                    sqlstate="42501",
                )
        self.assertEqual(
            sql("SELECT count(*) FROM pg_policy WHERE polrelid='portal.\"identityBinding\"'::regclass AND polname IN ('INSERT','UPDATE','DELETE') "
                "AND coalesce(pg_get_expr(polqual,polrelid),'false')='false' AND coalesce(pg_get_expr(polwithcheck,polrelid),'false')='false'"),
            "3",
        )

    def test_migrate_role_enrolls_and_identical_rerun_is_a_noop(self):
        subject = "accounts.google.com:100000000000000000902"
        output = sql(as_migrator(
            enroll(subject, "company-a", "alice"),
            enroll(subject, "company-a", "alice"),
            "RESET ROLE",
            f"SELECT count(*)::text FROM portal.\"identityBinding\" WHERE issuer='{ISSUER}' AND subject='{subject}'",
            f"SELECT public.portal_resolve_workforce_identity('{ISSUER}','{subject}','company-a')",
        ))
        first, second, resolved = json_lines(output)
        self.assertEqual(first["canonicalUserId"], "alice")
        self.assertEqual(first["companyId"], "company-a")
        self.assertTrue(first["active"])
        self.assertEqual(first["revocationVersion"], 1)
        self.assertEqual(first["version"], 1)
        self.assertEqual(first["capabilities"], ["portal.read"])
        self.assertEqual(second, first)
        self.assertIn("1", output.splitlines())
        self.assertEqual(resolved["actorId"], "alice")
        self.assertTrue(resolved["bindingActive"] and resolved["userActive"] and resolved["membershipActive"])

    def test_capability_change_updates_the_ceiling_in_place(self):
        subject = "accounts.google.com:100000000000000000903"
        first, second = json_lines(sql(as_migrator(
            enroll(subject, "company-a", "alice"),
            enroll(subject, "company-a", "alice", "ARRAY['source.entities.search','portal.read','portal.read']"),
        )))
        self.assertEqual(second["id"], first["id"])
        self.assertEqual(second["version"], 2)
        self.assertEqual(second["revocationVersion"], 1)
        self.assertEqual(second["capabilities"], ["portal.read", "source.entities.search"])

    def test_email_shaped_or_non_iap_subject_is_rejected(self):
        for subject in ("alice@example.com", "subject-a", "accounts.google.com:", "accounts.google.com:abc"):
            with self.subTest(subject=subject):
                sql(as_migrator(enroll(subject, "company-a", "alice")), succeeds=False, sqlstate="22023")

    def test_empty_or_malformed_capabilities_are_rejected(self):
        subject = "accounts.google.com:100000000000000000904"
        sql(as_migrator(enroll(subject, "company-a", "alice", "ARRAY[]")), succeeds=False, sqlstate="22023")
        sql(as_migrator(enroll(subject, "company-a", "alice", "ARRAY['Portal.Read']")), succeeds=False, sqlstate="22023")

    def test_inactive_user_missing_membership_or_unknown_user_is_rejected(self):
        subject = "accounts.google.com:100000000000000000905"
        sql(
            f"BEGIN; UPDATE public.\"user\" SET active=false WHERE id='alice'; SET LOCAL ROLE portal_migrate; {enroll(subject, 'company-a', 'alice')}; ROLLBACK",
            succeeds=False,
            sqlstate="P0002",
        )
        sql(
            f"BEGIN; DELETE FROM public.\"userToCompany\" WHERE \"userId\"='alice' AND \"companyId\"='company-a'; SET LOCAL ROLE portal_migrate; {enroll(subject, 'company-a', 'alice')}; ROLLBACK",
            succeeds=False,
            sqlstate="P0002",
        )
        sql(as_migrator(enroll(subject, "company-a", "bob")), succeeds=False, sqlstate="P0002")
        sql(as_migrator(enroll(subject, "company-a", "nobody")), succeeds=False, sqlstate="P0002")
        self.assertEqual(
            sql(f"SELECT count(*) FROM portal.\"identityBinding\" WHERE subject='{subject}'"),
            "0",
        )

    def test_subject_bound_to_a_different_user_is_rejected_in_any_company(self):
        subject = "accounts.google.com:100000000000000000906"
        sql(as_migrator(enroll(subject, "company-a", "alice"), enroll(subject, "company-a", "revoked")), succeeds=False, sqlstate="23505")
        sql(as_migrator(enroll(subject, "company-a", "alice"), enroll(subject, "company-b", "bob")), succeeds=False, sqlstate="23505")

    def test_unbind_deactivates_and_advances_revocation_then_reenroll_keeps_it(self):
        subject = "accounts.google.com:100000000000000000907"
        enrolled, unbound, resolved, again = json_lines(sql(as_migrator(
            enroll(subject, "company-a", "alice"),
            unbind(subject, "company-a"),
            f"SELECT public.portal_resolve_workforce_identity('{ISSUER}','{subject}','company-a')",
            enroll(subject, "company-a", "alice"),
        )))
        self.assertTrue(enrolled["active"])
        self.assertFalse(unbound["active"])
        self.assertEqual(unbound["revocationVersion"], 2)
        self.assertEqual(unbound["version"], 2)
        self.assertFalse(resolved["bindingActive"])
        self.assertTrue(again["active"])
        self.assertEqual(again["revocationVersion"], 2)
        self.assertEqual(again["version"], 3)
        self.assertEqual(again["id"], enrolled["id"])

    def test_unbind_without_a_binding_is_rejected(self):
        sql(as_migrator(unbind("accounts.google.com:100000000000000000908", "company-a")), succeeds=False, sqlstate="P0002")


if __name__ == "__main__":
    unittest.main()
