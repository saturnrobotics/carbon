import unittest
from concurrent.futures import ThreadPoolExecutor
from test_schema import sql

PREFIX="BEGIN; INSERT INTO knowledge_metering.policy(\"companyId\",endpoint,\"companyTokens\",\"userTokens\",\"companyMicroUsd\",\"userMicroUsd\",\"requestsPerMinute\",\"concurrencyLimit\") VALUES ('company-a','answer',1000,600,1000,600,10,2) ON CONFLICT DO NOTHING; SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.company_id='company-a'; SET LOCAL knowledge.caller_id='query'; "

class BudgetTests(unittest.TestCase):
 def test_reservation_is_durable_and_retry_is_idempotent(self):
  result=sql(PREFIX+"SELECT knowledge_metering.reserve('answer','request-1',repeat('a',64),400,400); SELECT knowledge_metering.reserve('answer','request-1',repeat('a',64),400,400); RESET ROLE; SELECT count(*) FROM knowledge_metering.reservation WHERE \"requestId\"='request-1' AND endpoint='answer' AND \"companyId\"='company-a' AND \"actorId\"='alice'; ROLLBACK")
  self.assertEqual(result.splitlines()[-2], '1')
 def test_cap_is_not_bypassed_by_cache_loss(self):
  sql(PREFIX+"SELECT knowledge_metering.reserve('answer','request-1',repeat('a',64),400,400); SELECT knowledge_metering.reserve('answer','request-2',repeat('b',64),400,400); ROLLBACK",succeeds=False)
 def test_changed_payload_retry_is_rejected(self):
  sql(PREFIX+"SELECT knowledge_metering.reserve('answer','request-1',repeat('a',64),100,100); SELECT knowledge_metering.reserve('answer','request-1',repeat('b',64),100,100); ROLLBACK",succeeds=False)
 def test_no_policy_or_identity_is_default_deny(self):
  sql("BEGIN; SET LOCAL ROLE knowledge_read; SELECT knowledge_metering.reserve('answer','r',repeat('a',64),1,1); ROLLBACK",succeeds=False)
 def test_concurrent_reservations_cannot_overspend(self):
  sql("DELETE FROM knowledge_metering.reservation WHERE endpoint='concurrency-test'; INSERT INTO knowledge_metering.policy(\"companyId\",endpoint,\"companyTokens\",\"userTokens\",\"companyMicroUsd\",\"userMicroUsd\",\"requestsPerMinute\",\"concurrencyLimit\") VALUES ('company-a','concurrency-test',500,500,500,500,100,100) ON CONFLICT DO NOTHING")
  def reserve(index):
   statement="BEGIN; SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.company_id='company-a'; SET LOCAL knowledge.caller_id='query'; SELECT knowledge_metering.reserve('concurrency-test','request-%d',repeat('a',64),300,300); COMMIT" % index
   try: sql(statement); return True
   except AssertionError: return False
  with ThreadPoolExecutor(max_workers=8) as pool:
   self.assertEqual(sum(pool.map(reserve,range(8))),1)
  self.assertEqual(sql("SELECT sum(\"reservedTokens\") FROM knowledge_metering.reservation WHERE endpoint='concurrency-test'"),'300')
 def test_actual_usage_cannot_exceed_reserved_ceiling(self):
  sql(PREFIX+"SELECT knowledge_metering.reserve('answer','request-1',repeat('a',64),100,100); SELECT knowledge_metering.settle('answer','request-1',101,100); ROLLBACK",succeeds=False)
 def test_runtime_cannot_edit_policy_or_directly_write_ledger(self):
  sql(PREFIX+"UPDATE knowledge_metering.policy SET \"userTokens\"=99999; ROLLBACK",succeeds=False)
  sql(PREFIX+"DELETE FROM knowledge_metering.reservation; ROLLBACK",succeeds=False)

if __name__=='__main__':unittest.main()
