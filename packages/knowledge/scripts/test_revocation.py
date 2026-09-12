"""Identity revocation propagation proofs through real database roles.

Deactivating a Carbon user or removing a company membership must revoke every
affected knowledge."identityBinding" (active=false, revocationVersion+1) so a
warmed principal or answer cache is refused on the next request. Every case
runs against the labelled disposable fixture and rolls back its own writes.
Synthetic subjects use the IAP shape with reserved numeric ids.
"""
import json
import unittest
from pathlib import Path

from test_schema import sql

ISSUER = "https://cloud.google.com/iap"
TRIGGER_FUNCTION = "public.knowledge_propagate_identity_revocation()"
TRIGGERS = (
    ("public.\"user\"", "knowledge_identity_revocation_on_user_deactivation"),
    ("public.\"userToCompany\"", "knowledge_identity_revocation_on_membership_removal"),
)
RUNTIME_ROLES = (
    "knowledge_read",
    "knowledge_ingest",
    "knowledge_review",
    "knowledge_actions",
    "knowledge_maintenance",
    "knowledge_migrate",
)
# The exact predicate cache/epochs.server.ts evaluates on every delivery,
# reduced to the policyVersion string it derives.
READER_SNAPSHOT = (
    "SELECT 'snapshot:' || coalesce(string_agg(id || ':' || \"revocationVersion\", '|' ORDER BY id), '') "
    "FROM knowledge.\"identityBinding\" "
    "WHERE \"companyId\"=knowledge.company_id() AND \"canonicalUserId\"=knowledge.actor_id() AND active"
)


def enroll(subject, company, user):
    # Fixed synthetic values only; never production input.
    return (
        f"SELECT knowledge.enroll_workforce_identity('{ISSUER}','{subject}','{company}','{user}',"
        "ARRAY['knowledge.read']::text[])"
    )


def resolve(subject, company):
    return f"SELECT public.knowledge_resolve_workforce_identity('{ISSUER}','{subject}','{company}')"


def bindings_of(user):
    return f"SELECT to_jsonb(b) FROM knowledge.\"identityBinding\" b WHERE \"canonicalUserId\"='{user}' ORDER BY id"


def as_reader(actor, company):
    return (
        f"SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.actor_id='{actor}'; "
        f"SET LOCAL knowledge.company_id='{company}'; {READER_SNAPSHOT}; RESET ROLE"
    )


def as_migrator(*statements):
    return "SET LOCAL ROLE knowledge_migrate; " + "; ".join(statements) + "; RESET ROLE"


def transaction(*statements):
    return sql("BEGIN; " + "; ".join(statements) + "; ROLLBACK")


def json_lines(output):
    return [json.loads(line) for line in output.splitlines() if line.startswith("{")]


def snapshots(output):
    return [line for line in output.splitlines() if line.startswith("snapshot:")]


def revocation_version(bindings, binding_id):
    # revocationVersion only ever increases and nothing can put it back, so every
    # expectation here is a delta against what this same transaction read first.
    # A literal would make the case pass only on a database in which no earlier
    # suite had revoked one of these shared fixture bindings.
    return bindings[binding_id]["revocationVersion"]


class RevocationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql(Path(__file__).with_name("policy-fixtures.sql").read_text())

    def test_trigger_function_is_owner_definer_with_no_grantee(self):
        self.assertEqual(
            sql(
                "SELECT pg_get_userbyid(proowner) || ':' || prosecdef::text FROM pg_proc "
                f"WHERE oid='{TRIGGER_FUNCTION}'::regprocedure"
            ),
            "knowledge_enrollment_owner:true",
        )
        self.assertEqual(
            sql(
                "SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a "
                f"WHERE p.oid='{TRIGGER_FUNCTION}'::regprocedure AND a.grantee=0)"
            ),
            "f",
        )
        for role in RUNTIME_ROLES + ("anon", "authenticated"):
            with self.subTest(role=role):
                self.assertEqual(
                    sql(f"SELECT has_function_privilege('{role}','{TRIGGER_FUNCTION}','EXECUTE')"),
                    "f",
                )
        # The migrator's temporary membership used for the ownership hand-over
        # is gone: nothing can act as the owner role.
        self.assertEqual(
            sql("SELECT count(*) FROM pg_auth_members WHERE roleid='knowledge_enrollment_owner'::regrole"),
            "0",
        )
        self.assertEqual(
            sql("SELECT has_schema_privilege('knowledge_enrollment_owner','public','CREATE')"),
            "f",
        )
        for table, trigger in TRIGGERS:
            with self.subTest(trigger=trigger):
                self.assertEqual(
                    sql(
                        "SELECT tgenabled FROM pg_trigger "
                        f"WHERE tgrelid='{table}'::regclass AND tgname='{trigger}' "
                        f"AND tgfoid='{TRIGGER_FUNCTION}'::regprocedure"
                    ),
                    "O",
                )
        # The function is attached nowhere else: permission edits are covered by
        # permissionsVersion, not by a third trigger.
        self.assertEqual(
            sql(
                "SELECT string_agg(tgrelid::regclass::text, ',' ORDER BY tgrelid::regclass::text) "
                f"FROM pg_trigger WHERE tgfoid='{TRIGGER_FUNCTION}'::regprocedure"
            ),
            "\"user\",\"userToCompany\"",
        )

    def test_user_deactivation_revokes_every_binding_in_every_company(self):
        subject_a = "accounts.google.com:100000000000000000921"
        subject_b = "accounts.google.com:100000000000000000922"
        output = transaction(
            "INSERT INTO public.\"userToCompany\"(\"userId\",\"companyId\") VALUES ('alice','company-b')",
            as_migrator(enroll(subject_a, "company-a", "alice"), enroll(subject_b, "company-b", "alice")),
            bindings_of("alice"),
            bindings_of("bob"),
            as_reader("alice", "company-a"),
            "UPDATE public.\"user\" SET active=false WHERE id='alice'",
            as_reader("alice", "company-a"),
            bindings_of("alice"),
            resolve(subject_a, "company-a"),
            bindings_of("bob"),
            # Re-activation never re-enables a binding; enrollment is explicit.
            "UPDATE public.\"user\" SET active=true WHERE id='alice'",
            bindings_of("alice"),
        )
        rows = json_lines(output)
        self.assertEqual(len(rows), 14)
        enrolled_a, enrolled_b = rows[0], rows[1]
        alice_before = {row["id"]: row for row in rows[2:5]}
        bob_before = rows[5]
        alice_after = {row["id"]: row for row in rows[6:9]}
        resolved = rows[9]
        bob_after = rows[10]
        alice_reactivated = {row["id"]: row for row in rows[11:14]}
        self.assertEqual(sorted(alice_before), sorted(["id-alice", enrolled_a["id"], enrolled_b["id"]]))
        before, after = snapshots(output)
        self.assertEqual(
            before,
            f"snapshot:id-alice:{revocation_version(alice_before, 'id-alice')}"
            f"|{enrolled_a['id']}:{revocation_version(alice_before, enrolled_a['id'])}",
        )
        self.assertEqual(after, "snapshot:")
        for binding_id, row in alice_after.items():
            with self.subTest(binding=binding_id):
                self.assertFalse(row["active"])
                self.assertEqual(
                    row["revocationVersion"], revocation_version(alice_before, binding_id) + 1
                )
                self.assertEqual(row["version"], alice_before[binding_id]["version"] + 1)
        self.assertFalse(resolved["bindingActive"])
        self.assertFalse(resolved["userActive"])
        self.assertEqual(
            resolved["revocationVersion"], revocation_version(alice_after, enrolled_a["id"])
        )
        # An unrelated user's binding is untouched: still active, counter unmoved.
        self.assertEqual(bob_after["id"], bob_before["id"])
        self.assertTrue(bob_after["active"])
        self.assertEqual(bob_after["revocationVersion"], bob_before["revocationVersion"])
        self.assertEqual(alice_reactivated, alice_after)

    def test_deactivation_by_authenticated_role_fires_without_an_execute_grant(self):
        output = transaction(
            bindings_of("alice"),
            "SET LOCAL ROLE authenticated",
            "SELECT public.knowledge_fixture_mutator()",
            "RESET ROLE",
            bindings_of("alice"),
        )
        before, after = json_lines(output)
        self.assertEqual([before["id"], after["id"]], ["id-alice", "id-alice"])
        self.assertFalse(after["active"])
        self.assertEqual(after["revocationVersion"], before["revocationVersion"] + 1)

    def test_membership_removal_revokes_only_that_company(self):
        subject_a = "accounts.google.com:100000000000000000923"
        subject_b = "accounts.google.com:100000000000000000924"
        output = transaction(
            "INSERT INTO public.\"userToCompany\"(\"userId\",\"companyId\") VALUES ('alice','company-b')",
            as_migrator(enroll(subject_a, "company-a", "alice"), enroll(subject_b, "company-b", "alice")),
            bindings_of("alice"),
            "DELETE FROM public.\"userToCompany\" WHERE \"userId\"='alice' AND \"companyId\"='company-a'",
            as_reader("alice", "company-a"),
            as_reader("alice", "company-b"),
            bindings_of("alice"),
            resolve(subject_a, "company-a"),
            resolve(subject_b, "company-b"),
        )
        rows = json_lines(output)
        self.assertEqual(len(rows), 10)
        enrolled_b = rows[1]
        before = {row["id"]: row for row in rows[2:5]}
        after = {row["id"]: row for row in rows[5:8]}
        self.assertEqual(
            snapshots(output),
            ["snapshot:", f"snapshot:{enrolled_b['id']}:{revocation_version(before, enrolled_b['id'])}"],
        )
        self.assertEqual(
            sorted(row["companyId"] for row in after.values()),
            ["company-a", "company-a", "company-b"],
        )
        for binding_id, row in after.items():
            with self.subTest(binding=binding_id):
                revoked_here = row["companyId"] == "company-a"
                self.assertEqual(row["active"], not revoked_here)
                self.assertEqual(
                    row["revocationVersion"],
                    revocation_version(before, binding_id) + (1 if revoked_here else 0),
                )
        resolved_a, resolved_b = rows[8], rows[9]
        self.assertFalse(resolved_a["bindingActive"])
        self.assertFalse(resolved_a["membershipActive"])
        self.assertTrue(resolved_b["bindingActive"] and resolved_b["membershipActive"])

    def test_unrelated_user_updates_leave_bindings_untouched(self):
        output = transaction(
            bindings_of("alice"),
            "UPDATE public.\"user\" SET active=true WHERE id='alice'",
            "UPDATE public.\"user\" SET \"updatedAt\"=now() WHERE id='alice'",
            bindings_of("alice"),
        )
        before, after = json_lines(output)
        self.assertTrue(after["active"])
        self.assertEqual(after["revocationVersion"], before["revocationVersion"])

    def test_permission_edit_changes_permissions_version_but_not_revocation(self):
        subject = "accounts.google.com:100000000000000000925"
        output = transaction(
            as_migrator(enroll(subject, "company-a", "alice")),
            resolve(subject, "company-a"),
            "INSERT INTO public.\"userPermission\"(id,permissions) VALUES ('alice','{\"knowledge_view\":[\"company-a\"]}') "
            "ON CONFLICT (id) DO UPDATE SET permissions=EXCLUDED.permissions",
            resolve(subject, "company-a"),
        )
        _, before, after = json_lines(output)
        self.assertNotEqual(before["permissionsVersion"], after["permissionsVersion"])
        self.assertEqual(after["revocationVersion"], before["revocationVersion"])
        self.assertTrue(after["bindingActive"])

    def test_unbind_denies_the_reader_snapshot_like_the_triggers_do(self):
        subject = "accounts.google.com:100000000000000000926"
        output = transaction(
            as_migrator(enroll(subject, "company-a", "revoked")),
            as_reader("revoked", "company-a"),
            as_migrator(f"SELECT knowledge.unbind_workforce_identity('{ISSUER}','{subject}','company-a')"),
            as_reader("revoked", "company-a"),
        )
        enrolled, unbound = json_lines(output)
        self.assertEqual(
            snapshots(output),
            [f"snapshot:{enrolled['id']}:{enrolled['revocationVersion']}", "snapshot:"],
        )
        self.assertFalse(unbound["active"])
        self.assertEqual(unbound["revocationVersion"], enrolled["revocationVersion"] + 1)

    def test_migration_reapplies_idempotently(self):
        migration = (
            Path(__file__).resolve().parents[3]
            / "packages/database/supabase/migrations/20260911211525_knowledge-identity-revocation.sql"
        ).read_text()
        count = f"SELECT 'triggers:' || count(*) FROM pg_trigger WHERE tgfoid='{TRIGGER_FUNCTION}'::regprocedure"
        output = transaction(
            migration,
            count,
            bindings_of("alice"),
            "SELECT public.knowledge_fixture_mutator()",
            bindings_of("alice"),
        )
        self.assertIn("triggers:2", output.splitlines())
        before, after = json_lines(output)
        self.assertFalse(after["active"])
        self.assertEqual(after["revocationVersion"], before["revocationVersion"] + 1)


if __name__ == "__main__":
    unittest.main()
