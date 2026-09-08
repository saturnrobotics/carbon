"""Behavioral SQL checks against an explicitly disposable Docker database.

The container must have the label knowledge.disposable=true. No host database is
accepted, and this runner never removes or rebuilds a database.
"""
import json
import os
import subprocess
import unittest
from pathlib import Path


CONTAINER = os.environ.get("KNOWLEDGE_TEST_CONTAINER", "knowledge-schema-test")


def sql(statement, *, succeeds=True):
    inspected = subprocess.run(
        ["docker", "inspect", CONTAINER], check=True, capture_output=True, text=True
    )
    labels = json.loads(inspected.stdout)[0]["Config"].get("Labels") or {}
    if labels.get("knowledge.disposable") != "true":
        raise RuntimeError("Refusing an unlabelled database container")
    result = subprocess.run(
        ["docker", "exec", "-i", "-e", "PGPASSWORD=synthetic-test-only", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1",
         "-U", "supabase_admin", "-d", "knowledge_test", "-At"],
        input=statement, capture_output=True, text=True,
    )
    if succeeds and result.returncode:
        raise AssertionError(result.stderr)
    if not succeeds and result.returncode == 0:
        raise AssertionError("Forbidden SQL unexpectedly succeeded")
    return result.stdout.strip()


TABLES = ["source", "identityBinding", "sourceUserBinding", "document",
          "documentVersion", "chunk", "entity", "entityLink", "grant",
          "groupMembership", "intake", "extraction", "outbox", "command",
          "conversation", "audit"]


class SchemaTests(unittest.TestCase):
    def test_all_tables_have_forced_row_security_and_audit_columns(self):
        tables = sql("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                     "WHERE n.nspname='knowledge' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity ORDER BY 1")
        self.assertEqual(tables.splitlines(), sorted(TABLES))
        for table in TABLES:
            self.assertEqual(sql(f"SELECT count(*) FROM information_schema.columns WHERE table_schema='knowledge' "
                                 f"AND table_name='{table}' AND column_name IN ('id','companyId','createdBy','createdAt','updatedBy','updatedAt')"), "6")

    def test_read_role_has_no_mutation_or_owner_privileges(self):
        self.assertEqual(sql("SELECT count(*) FROM pg_roles WHERE rolname='knowledge_read' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin"), "1")
        self.assertEqual(sql("SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='knowledge_read' AND privilege_type != 'SELECT'"), "0")
        sql("BEGIN; SET LOCAL ROLE knowledge_read; INSERT INTO knowledge.source DEFAULT VALUES; ROLLBACK", succeeds=False)

    def test_browser_roles_cannot_enter_schema(self):
        self.assertEqual(sql("SELECT has_schema_privilege('anon','knowledge','USAGE') OR has_schema_privilege('authenticated','knowledge','USAGE')"), "f")

    def test_unbound_actor_is_default_deny(self):
        self.assertEqual(sql("BEGIN; SET LOCAL ROLE knowledge_read; SELECT count(*) FROM knowledge.document; ROLLBACK").splitlines()[-2], "0")


def as_reader(actor, company, query):
    # Actor/company are fixed synthetic test values, not production SQL inputs.
    return sql(f"BEGIN; SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.actor_id='{actor}'; "
               f"SET LOCAL knowledge.company_id='{company}'; {query}; ROLLBACK").splitlines()[4:-1]


class PolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql(Path(__file__).with_name('policy-fixtures.sql').read_text())

    def test_visible_manual_and_chunks_exclude_same_blob_with_other_acl(self):
        self.assertEqual(as_reader('alice', 'company-a', 'SELECT id FROM knowledge.document ORDER BY id'), ['doc-a'])
        self.assertEqual(as_reader('alice', 'company-a', 'SELECT text FROM knowledge.chunk ORDER BY id'), ['Visible manual'])

    def test_document_grant_supports_source_metadata_join_for_search(self):
        query = 'SELECT c.id FROM knowledge.chunk c JOIN knowledge.document d ON d.id=c."documentId" AND d."companyId"=c."companyId" JOIN knowledge.source s ON s.id=d."sourceId" AND s."companyId"=d."companyId" WHERE c.fts @@ websearch_to_tsquery(\'english\',\'manual\') ORDER BY c.id'
        self.assertEqual(as_reader('alice','company-a',query), ['chunk-doc-a'])

    def test_company_selection_does_not_grant_membership(self):
        self.assertEqual(as_reader('alice', 'company-b', 'SELECT id FROM knowledge.document'), [])
        self.assertEqual(as_reader('bob', 'company-b', 'SELECT id FROM knowledge.document'), ['doc-b'])

    def test_local_permission_cannot_broaden_source_permission(self):
        self.assertEqual(as_reader('alice', 'company-a', "SELECT id FROM knowledge.document WHERE id='doc-hidden'"), [])

    def test_revoked_source_binding_denies_base_rows_and_ranked_search(self):
        value = sql("BEGIN; UPDATE knowledge.\"sourceUserBinding\" SET active=false,version=version+1 WHERE id='source-binding-a'; SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.company_id='company-a'; SELECT count(*) FROM knowledge.document; SELECT count(*) FROM knowledge.search_lexical('company-a',ARRAY['source-a'],'manual',10); ROLLBACK")
        self.assertEqual([line for line in value.splitlines() if line.isdigit()], ['0','0'])

    def test_current_carbon_user_deactivation_denies_index_without_sync_lag(self):
        value=sql("BEGIN; UPDATE public.\"user\" SET active=false WHERE id='alice'; SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.company_id='company-a'; SELECT count(*) FROM knowledge.document; ROLLBACK")
        self.assertEqual(value.splitlines()[-2], '0')

    def test_current_company_membership_removal_denies_index_without_sync_lag(self):
        value=sql("BEGIN; DELETE FROM public.\"userToCompany\" WHERE \"userId\"='alice' AND \"companyId\"='company-a'; SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.company_id='company-a'; SELECT count(*) FROM knowledge.document; ROLLBACK")
        self.assertEqual(value.splitlines()[-2], '0')

    def test_disabled_binding_denies_every_document(self):
        self.assertEqual(as_reader('revoked', 'company-a', 'SELECT id FROM knowledge.document'), [])

    def test_document_version_cannot_be_retargeted(self):
        sql("BEGIN; UPDATE knowledge.document SET \"currentVersionId\"='version-doc-hidden',version=version+1 WHERE id='doc-a'; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK", succeeds=False)
        sql("BEGIN; INSERT INTO knowledge.chunk(id,\"companyId\",\"createdBy\",\"documentId\",\"documentVersionId\",ordinal,text,\"tokenCount\",\"embeddingProfile\",\"indexGeneration\") VALUES ('wrong','company-a','alice','doc-a','version-doc-hidden',0,'wrong',1,'synthetic',1); ROLLBACK", succeeds=False)

    def test_read_role_cannot_call_a_business_mutator(self):
        sql('BEGIN; SET LOCAL ROLE knowledge_read; INSERT INTO knowledge.command DEFAULT VALUES; ROLLBACK', succeeds=False)

    def test_transaction_local_actor_does_not_leak_to_next_request(self):
        result = sql("BEGIN; SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.company_id='company-a'; SELECT count(*) FROM knowledge.document; COMMIT; BEGIN; SET LOCAL ROLE knowledge_read; SELECT count(*) FROM knowledge.document; ROLLBACK")
        self.assertEqual([line for line in result.splitlines() if line.isdigit()], ['1','0'])

    def test_intake_owner_cannot_bypass_revoked_source_access(self):
        result = sql("BEGIN; INSERT INTO knowledge.intake(id,\"companyId\",\"createdBy\",\"sourceId\",\"ownerId\",\"idempotencyKey\") VALUES ('intake-denied','company-a','alice','source-a','alice','denied'); SET LOCAL ROLE knowledge_review; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.company_id='company-a'; SELECT count(*) FROM knowledge.intake WHERE id='intake-denied'; ROLLBACK")
        self.assertEqual([line for line in result.splitlines() if line.isdigit()], ['0'])

    def test_runtime_cannot_retarget_acl_scoped_record(self):
        sql("BEGIN; INSERT INTO knowledge.\"grant\"(id,\"companyId\",\"createdBy\",\"sourceId\",\"subjectKind\",\"subjectId\",capability,origin,\"policyVersion\") VALUES ('temporary-local','company-a','alice','source-a','user','alice','read','local',1),('temporary-source','company-a','alice','source-a','user','alice','read','source',1); INSERT INTO knowledge.intake(id,\"companyId\",\"createdBy\",\"sourceId\",\"ownerId\",\"idempotencyKey\") VALUES ('intake-retarget','company-a','alice','source-a','alice','retarget'); SET LOCAL ROLE knowledge_review; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.company_id='company-a'; UPDATE knowledge.intake SET \"ownerId\"='bob',version=version+1 WHERE id='intake-retarget'; ROLLBACK", succeeds=False)


class IdentityResolverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql(Path(__file__).with_name('policy-fixtures.sql').read_text())

    def test_read_role_resolves_only_the_exact_stable_binding(self):
        resolved = json.loads(sql("SET ROLE knowledge_read; SELECT public.knowledge_resolve_workforce_identity('https://identity.example.com','subject-a','company-a')").splitlines()[-1])
        self.assertEqual(resolved['actorId'], 'alice')
        self.assertEqual(resolved['companyId'], 'company-a')
        self.assertTrue(resolved['bindingActive'])
        self.assertTrue(resolved['userActive'])
        self.assertTrue(resolved['membershipActive'])
        self.assertEqual(resolved['capabilities'], ['knowledge.read', 'source.entities.search', 'kanban.ticket.create'])
        self.assertEqual(sql("SET ROLE knowledge_read; SELECT public.knowledge_resolve_workforce_identity('https://identity.example.com','subject-a','company-b') IS NULL").splitlines()[-1], 't')

    def test_browser_database_roles_cannot_enumerate_bindings(self):
        sql("SET ROLE authenticated; SELECT public.knowledge_resolve_workforce_identity('https://identity.example.com','subject-a','company-a')", succeeds=False)


if __name__ == "__main__":
    unittest.main()
