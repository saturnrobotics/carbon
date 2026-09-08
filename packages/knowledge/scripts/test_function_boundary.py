import unittest
from test_schema import sql

class FunctionBoundaryTests(unittest.TestCase):
 def test_query_role_cannot_execute_public_business_mutators(self):
  sql("BEGIN; SET LOCAL ROLE knowledge_read; SELECT public.knowledge_fixture_mutator(); ROLLBACK",succeeds=False)
 def test_write_roles_can_generate_ids_but_not_call_business_mutators(self):
  for role in ['knowledge_ingest','knowledge_review','knowledge_actions']:
   with self.subTest(role=role):
    result=sql("BEGIN; SET LOCAL ROLE " + role + "; SELECT public.id('synthetic') LIKE 'synthetic%'; ROLLBACK")
    self.assertEqual(result.splitlines()[-2], 't')
    sql("BEGIN; SET LOCAL ROLE " + role + "; SELECT public.knowledge_fixture_mutator(); ROLLBACK",succeeds=False)
 def test_existing_authenticated_execution_is_preserved(self):
  result=sql("BEGIN; SET LOCAL ROLE authenticated; SELECT public.knowledge_fixture_mutator(); RESET ROLE; SELECT active FROM public.\"user\" WHERE id='alice'; ROLLBACK")
  self.assertEqual(result.splitlines()[-2],'f')
 def test_query_role_still_executes_only_the_explicit_identity_rpc(self):
  result=sql("SET ROLE knowledge_read; SELECT public.knowledge_resolve_workforce_identity('https://identity.example.com','subject-a','company-a')->>'actorId'")
  self.assertEqual(result.splitlines()[-1],'alice')
if __name__=='__main__':unittest.main()
