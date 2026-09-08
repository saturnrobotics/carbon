import unittest
from test_schema import sql
PREFIX="BEGIN; UPDATE knowledge.source SET \"providerPolicy\"='{\"ingestDatabaseRoles\":[\"supabase_admin\"],\"machineCallers\":[\"worker\"]}',version=version+1 WHERE id='source-a'; INSERT INTO knowledge_metering.policy(\"companyId\",endpoint,\"companyTokens\",\"userTokens\",\"companyMicroUsd\",\"userMicroUsd\",\"requestsPerMinute\",\"concurrencyLimit\") VALUES ('company-a','embedding-index',10000,10000,10000,10000,100,10) ON CONFLICT DO NOTHING; SET LOCAL ROLE knowledge_ingest; SET LOCAL knowledge.actor_id=''; SET LOCAL knowledge.company_id='company-a'; SET LOCAL knowledge.caller_id='worker'; SET LOCAL knowledge.source_id='source-a'; "
class MachineBudgetTests(unittest.TestCase):
 def test_registered_source_indexer_is_billed_as_machine_not_employee(self):
  result=sql(PREFIX+"SELECT knowledge_metering.reserve('embedding-index','machine-1',repeat('a',64),100,100); RESET ROLE; SELECT \"actorId\"||':'||\"principalKind\" FROM knowledge_metering.reservation WHERE \"requestId\"='machine-1'; ROLLBACK")
  self.assertEqual(result.splitlines()[-2],'machine:worker:machine')
 def test_indexer_cannot_reserve_interactive_generation(self):
  sql(PREFIX+"SELECT knowledge_metering.reserve('answer','machine-1',repeat('a',64),100,100); ROLLBACK",succeeds=False)
 def test_indexer_requires_its_exact_source_grant(self):
  sql(PREFIX+"SET LOCAL knowledge.source_id='source-b'; SELECT knowledge_metering.reserve('embedding-index','machine-1',repeat('a',64),100,100); ROLLBACK",succeeds=False)
if __name__=='__main__':unittest.main()
