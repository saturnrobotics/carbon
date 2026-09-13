"""Behavioral SQL checks against an explicitly disposable Docker database.

The container must have the label portal.disposable=true. No host database is
accepted, and this runner never removes or rebuilds a database.
"""
import json
import os
import re
import subprocess
import unittest
from pathlib import Path


CONTAINER = os.environ.get("PORTAL_TEST_CONTAINER", "portal-schema-test")


def sql(statement, *, succeeds=True, sqlstate=None):
    inspected = subprocess.run(
        ["docker", "inspect", CONTAINER], check=True, capture_output=True, text=True
    )
    labels = json.loads(inspected.stdout)[0]["Config"].get("Labels") or {}
    if labels.get("portal.disposable") != "true":
        raise RuntimeError("Refusing an unlabelled database container")
    result = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            "-e",
            "PGPASSWORD=synthetic-test-only",
            CONTAINER,
            "psql",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-v",
            "VERBOSITY=verbose",
            "-U",
            "supabase_admin",
            "-d",
            "portal_test",
            "-At",
        ],
        input=statement,
        capture_output=True,
        text=True,
    )
    if succeeds and result.returncode:
        raise AssertionError(result.stderr)
    if not succeeds:
        if result.returncode == 0:
            raise AssertionError("Forbidden SQL unexpectedly succeeded")
        # ON_ERROR_STOP uses 3 for rejected SQL; a disconnect or crashed server
        # must never count as evidence that a permission boundary held.
        if result.returncode != 3:
            raise AssertionError(
                f"Expected SQL error (psql exit 3), got {result.returncode}: {result.stderr}"
            )
        if sqlstate and not re.search(
            rf"^ERROR:\s+{re.escape(sqlstate)}:", result.stderr, re.MULTILINE
        ):
            raise AssertionError(f"Expected SQLSTATE {sqlstate}: {result.stderr}")
    return result.stdout.strip()

TABLES = ["source", "identityBinding", "sourceUserBinding", "document",
          "documentVersion", "chunk", "entity", "entityLink", "grant",
          "groupMembership", "intake", "extraction", "outbox", "command",
          "conversation", "audit", "driveEnrollment", "driveItem"]

# Every (role, default expression) pair a portal INSERT can fire: each role
# holding INSERT on a portal table, against each of that table's defaults
# that calls a function. pg_depend records the call, so the pairing survives a
# generator gaining a new hop or a table gaining a new default.
IDENTIFIER_DEFAULT_WRITERS = """
SELECT DISTINCT a.grantee::regrole::text || ' | ' || pg_get_expr(d.adbin, d.adrelid)
FROM pg_attrdef d
JOIN pg_class c ON c.oid=d.adrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_depend dep ON dep.classid='pg_attrdef'::regclass AND dep.objid=d.oid
 AND dep.refclassid='pg_proc'::regclass
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
WHERE n.nspname='portal' AND a.privilege_type='INSERT' AND a.grantee<>0
ORDER BY 1
"""

# A role holding nothing but EXECUTE on the generator itself.
ID_PROBE = ("CREATE ROLE portal_id_probe NOLOGIN; "
            "GRANT EXECUTE ON FUNCTION public.id(text) TO portal_id_probe; ")


class SchemaTests(unittest.TestCase):
    def test_all_tables_have_forced_row_security_and_audit_columns(self):
        tables = sql("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                     "WHERE n.nspname='portal' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity ORDER BY 1")
        self.assertEqual(tables.splitlines(), sorted(TABLES))
        for table in TABLES:
            self.assertEqual(sql(f"SELECT count(*) FROM information_schema.columns WHERE table_schema='portal' "
                                 f"AND table_name='{table}' AND column_name IN ('id','companyId','createdBy','createdAt','updatedBy','updatedAt')"), "6")

    def test_read_role_has_no_mutation_or_owner_privileges(self):
        self.assertEqual(sql("SELECT count(*) FROM pg_roles WHERE rolname='portal_read' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin"), "1")
        self.assertEqual(sql("SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='portal_read' AND privilege_type != 'SELECT'"), "0")
        sql("BEGIN; SET LOCAL ROLE portal_read; INSERT INTO portal.source DEFAULT VALUES; ROLLBACK", succeeds=False, sqlstate="42501")

    def test_browser_roles_cannot_enter_schema(self):
        self.assertEqual(sql("SELECT has_schema_privilege('anon','portal','USAGE') OR has_schema_privilege('authenticated','portal','USAGE')"), "f")

    def test_unbound_actor_is_default_deny(self):
        self.assertEqual(sql("BEGIN; SET LOCAL ROLE portal_read; SELECT count(*) FROM portal.document; ROLLBACK").splitlines()[-2], "0")

    def test_every_portal_writer_can_evaluate_its_column_defaults(self):
        # Table privileges alone do not make a row insertable: the id defaults
        # call Carbon's invoker generator, which reaches further helpers in
        # public and extensions. portal_enrollment_owner shipped able to
        # INSERT into "identityBinding" and unable to evaluate its default, so
        # every enrollment was refused. Evaluating each default as each writer
        # is the check no new role can pass by accident.
        self.assertEqual(
            sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                "CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a "
                "WHERE n.nspname='portal' AND a.privilege_type='INSERT' AND a.grantee=0"),
            "0",
        )
        pairs = [line.split(" | ", 1) for line in sql(IDENTIFIER_DEFAULT_WRITERS).splitlines()]
        self.assertIn("portal_enrollment_owner", {role for role, _ in pairs})
        for role, expression in pairs:
            with self.subTest(role=role, default=expression):
                sql(f"BEGIN; SET LOCAL ROLE {role}; SELECT {expression}; ROLLBACK")

    def test_identifier_generator_requires_the_helper_grants(self):
        # The check above only proves something while public.id costs a grant to
        # reach. The fixture's earlier gen_random_uuid() stand-in needed none,
        # which is exactly why the missing enrollment grants passed every suite.
        sql("BEGIN; " + ID_PROBE + "SET LOCAL ROLE portal_id_probe; SELECT public.id('probe'); ROLLBACK",
            succeeds=False, sqlstate="42501")
        granted = sql("BEGIN; " + ID_PROBE +
                      "GRANT USAGE ON SCHEMA extensions TO portal_id_probe; "
                      "GRANT EXECUTE ON FUNCTION public.uuid_to_base58(uuid), "
                      "extensions.uuid_generate_v4() TO portal_id_probe; "
                      "SET LOCAL ROLE portal_id_probe; SELECT public.id('probe'); ROLLBACK")
        # Base58 of a v4 UUID, so the grants bought the whole closure, not a
        # hyphenated UUID from some other definition that happened to answer.
        self.assertRegex(granted, r"(?m)^probe_[1-9A-HJ-NP-Za-km-z]{20,}$")


def as_reader(actor, company, query):
    # Actor/company are fixed synthetic test values, not production SQL inputs.
    return sql(f"BEGIN; SET LOCAL ROLE portal_read; SET LOCAL portal.actor_id='{actor}'; "
               f"SET LOCAL portal.company_id='{company}'; {query}; ROLLBACK").splitlines()[4:-1]


class PolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql(Path(__file__).with_name('policy-fixtures.sql').read_text())

    def test_ingest_source_read_uses_machine_scope_without_human_helper_acl_failure(self):
        result = sql("""
BEGIN;
INSERT INTO portal.source(id,"companyId","createdBy",kind,"externalId","displayName","ownerId",classification,"providerPolicy")
VALUES
 ('ingest-source-proof','company-b','bob','upload','ingest-proof','Synthetic ingest proof','bob','internal',
  '{"machineCallers":["ingest-proof-caller"],"ingestDatabaseRoles":["supabase_admin"]}'),
 ('ingest-source-denied','company-b','bob','upload','ingest-denied','Synthetic denied source','bob','internal',
  '{"machineCallers":["another-caller"],"ingestDatabaseRoles":["supabase_admin"]}');
SET LOCAL ROLE portal_ingest;
SET LOCAL portal.company_id='company-b';
SET LOCAL portal.actor_id='';
SET LOCAL portal.caller_id='ingest-proof-caller';
SET LOCAL portal.source_id='ingest-source-proof';
SELECT 'allowed:' || coalesce(string_agg(id,',' ORDER BY id),'') FROM portal.source;
SET LOCAL portal.caller_id='unassigned-caller';
SELECT 'wrong-caller:' || count(*) FROM portal.source;
SET LOCAL portal.caller_id='ingest-proof-caller';
SET LOCAL portal.company_id='company-a';
SELECT 'wrong-company:' || count(*) FROM portal.source;
ROLLBACK;
""")
        self.assertIn('allowed:ingest-source-proof', result.splitlines())
        self.assertIn('wrong-caller:0', result.splitlines())
        self.assertIn('wrong-company:0', result.splitlines())

    def test_visible_manual_and_chunks_exclude_same_blob_with_other_acl(self):
        self.assertEqual(as_reader('alice', 'company-a', 'SELECT id FROM portal.document ORDER BY id'), ['doc-a'])
        self.assertEqual(as_reader('alice', 'company-a', 'SELECT text FROM portal.chunk ORDER BY id'), ['Visible manual'])

    def test_document_grant_supports_source_metadata_join_for_search(self):
        query = 'SELECT c.id FROM portal.chunk c JOIN portal.document d ON d.id=c."documentId" AND d."companyId"=c."companyId" JOIN portal.source s ON s.id=d."sourceId" AND s."companyId"=d."companyId" WHERE c.fts @@ websearch_to_tsquery(\'english\',\'manual\') ORDER BY c.id'
        self.assertEqual(as_reader('alice','company-a',query), ['chunk-doc-a'])

    def test_company_selection_does_not_grant_membership(self):
        self.assertEqual(as_reader('alice', 'company-b', 'SELECT id FROM portal.document'), [])
        self.assertEqual(as_reader('bob', 'company-b', 'SELECT id FROM portal.document'), ['doc-b'])

    def test_local_permission_cannot_broaden_source_permission(self):
        self.assertEqual(as_reader('alice', 'company-a', "SELECT id FROM portal.document WHERE id='doc-hidden'"), [])

    def test_revoked_source_binding_denies_base_rows_and_ranked_search(self):
        value = sql("BEGIN; UPDATE portal.\"sourceUserBinding\" SET active=false,version=version+1 WHERE id='source-binding-a'; SET LOCAL ROLE portal_read; SET LOCAL portal.actor_id='alice'; SET LOCAL portal.company_id='company-a'; SELECT count(*) FROM portal.document; SELECT count(*) FROM portal.search_lexical('company-a',ARRAY['source-a'],'manual',10); ROLLBACK")
        self.assertEqual([line for line in value.splitlines() if line.isdigit()], ['0','0'])

    def test_current_carbon_user_deactivation_denies_index_without_sync_lag(self):
        value=sql("BEGIN; UPDATE public.\"user\" SET active=false WHERE id='alice'; SET LOCAL ROLE portal_read; SET LOCAL portal.actor_id='alice'; SET LOCAL portal.company_id='company-a'; SELECT count(*) FROM portal.document; ROLLBACK")
        self.assertEqual(value.splitlines()[-2], '0')

    def test_current_company_membership_removal_denies_index_without_sync_lag(self):
        value=sql("BEGIN; DELETE FROM public.\"userToCompany\" WHERE \"userId\"='alice' AND \"companyId\"='company-a'; SET LOCAL ROLE portal_read; SET LOCAL portal.actor_id='alice'; SET LOCAL portal.company_id='company-a'; SELECT count(*) FROM portal.document; ROLLBACK")
        self.assertEqual(value.splitlines()[-2], '0')

    def test_disabled_binding_denies_every_document(self):
        self.assertEqual(as_reader('revoked', 'company-a', 'SELECT id FROM portal.document'), [])

    def test_document_version_cannot_be_retargeted(self):
        sql("BEGIN; UPDATE portal.document SET \"currentVersionId\"='version-doc-hidden',version=version+1 WHERE id='doc-a'; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK", succeeds=False)
        sql("BEGIN; INSERT INTO portal.chunk(id,\"companyId\",\"createdBy\",\"documentId\",\"documentVersionId\",ordinal,text,\"tokenCount\",\"embeddingProfile\",\"indexGeneration\") VALUES ('wrong','company-a','alice','doc-a','version-doc-hidden',0,'wrong',1,'synthetic',1); ROLLBACK", succeeds=False)

    def test_read_role_cannot_call_a_business_mutator(self):
        sql('BEGIN; SET LOCAL ROLE portal_read; INSERT INTO portal.command DEFAULT VALUES; ROLLBACK', succeeds=False, sqlstate="42501")

    def test_transaction_local_actor_does_not_leak_to_next_request(self):
        result = sql("BEGIN; SET LOCAL ROLE portal_read; SET LOCAL portal.actor_id='alice'; SET LOCAL portal.company_id='company-a'; SELECT count(*) FROM portal.document; COMMIT; BEGIN; SET LOCAL ROLE portal_read; SELECT count(*) FROM portal.document; ROLLBACK")
        self.assertEqual([line for line in result.splitlines() if line.isdigit()], ['1','0'])

    def test_intake_owner_cannot_bypass_revoked_source_access(self):
        result = sql("BEGIN; INSERT INTO portal.intake(id,\"companyId\",\"createdBy\",\"sourceId\",\"ownerId\",\"idempotencyKey\") VALUES ('intake-denied','company-a','alice','source-a','alice','denied'); SET LOCAL ROLE portal_review; SET LOCAL portal.actor_id='alice'; SET LOCAL portal.company_id='company-a'; SELECT count(*) FROM portal.intake WHERE id='intake-denied'; ROLLBACK")
        self.assertEqual([line for line in result.splitlines() if line.isdigit()], ['0'])

    def test_runtime_cannot_retarget_acl_scoped_record(self):
        sql("BEGIN; INSERT INTO portal.\"grant\"(id,\"companyId\",\"createdBy\",\"sourceId\",\"subjectKind\",\"subjectId\",capability,origin,\"policyVersion\") VALUES ('temporary-local','company-a','alice','source-a','user','alice','read','local',1),('temporary-source','company-a','alice','source-a','user','alice','read','source',1); INSERT INTO portal.intake(id,\"companyId\",\"createdBy\",\"sourceId\",\"ownerId\",\"idempotencyKey\") VALUES ('intake-retarget','company-a','alice','source-a','alice','retarget'); SET LOCAL ROLE portal_review; SET LOCAL portal.actor_id='alice'; SET LOCAL portal.company_id='company-a'; UPDATE portal.intake SET \"ownerId\"='bob',version=version+1 WHERE id='intake-retarget'; ROLLBACK", succeeds=False)


class IdentityResolverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql(Path(__file__).with_name('policy-fixtures.sql').read_text())

    def test_read_role_resolves_only_the_exact_stable_binding(self):
        resolved = json.loads(sql("SET ROLE portal_read; SELECT public.portal_resolve_workforce_identity('https://identity.example.com','subject-a','company-a')").splitlines()[-1])
        self.assertEqual(resolved['actorId'], 'alice')
        self.assertEqual(resolved['companyId'], 'company-a')
        self.assertTrue(resolved['bindingActive'])
        self.assertTrue(resolved['userActive'])
        self.assertTrue(resolved['membershipActive'])
        self.assertEqual(resolved['capabilities'], ['portal.read', 'source.entities.search', 'kanban.ticket.create'])
        self.assertEqual(sql("SET ROLE portal_read; SELECT public.portal_resolve_workforce_identity('https://identity.example.com','subject-a','company-b') IS NULL").splitlines()[-1], 't')

    def test_browser_database_roles_cannot_enumerate_bindings(self):
        for role in ("anon", "authenticated"):
            with self.subTest(role=role):
                sql(
                    f"SET ROLE {role}; SELECT public.portal_resolve_workforce_identity("
                    "'https://identity.example.com','subject-a','company-a')",
                    succeeds=False,
                    sqlstate="42501",
                )


if __name__ == "__main__":
    unittest.main()
