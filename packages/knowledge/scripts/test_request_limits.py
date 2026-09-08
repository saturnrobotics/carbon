import concurrent.futures
import unittest
from test_schema import sql

class RequestLimitTests(unittest.TestCase):
 def test_current_identity_and_explicit_quota_are_required(self):
  result=sql("BEGIN; SET LOCAL ROLE knowledge_read; SELECT knowledge_metering.admit_request('knowledge.query'); ROLLBACK",succeeds=False)
  self.assertEqual(result, 'BEGIN\nSET')
 def test_atomic_company_limit_survives_parallel_requests_without_redis(self):
  sql("INSERT INTO knowledge_metering.\"requestPolicy\" VALUES ('company-a','knowledge.query',1,1) ON CONFLICT (\"companyId\",endpoint) DO UPDATE SET \"userPerMinute\"=1,\"companyPerMinute\"=1; DELETE FROM knowledge_metering.\"requestWindow\" WHERE \"companyId\"='company-a' AND endpoint='knowledge.query';")
  statement="BEGIN; SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.company_id='company-a'; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.caller_id='web'; SELECT knowledge_metering.admit_request('knowledge.query'); COMMIT;"
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
   results=list(executor.map(lambda _:sql(statement),range(8)))
  self.assertEqual(sum(result.splitlines()[-2]=='t' for result in results),1)
  sql("DELETE FROM knowledge_metering.\"requestWindow\" WHERE \"companyId\"='company-a' AND endpoint='knowledge.query'; UPDATE knowledge_metering.\"requestPolicy\" SET \"userPerMinute\"=1000,\"companyPerMinute\"=10000 WHERE \"companyId\"='company-a' AND endpoint='knowledge.query';")
 def test_read_role_cannot_edit_limits(self):
  sql("SET ROLE knowledge_read; DELETE FROM knowledge_metering.\"requestPolicy\";",succeeds=False)

if __name__=='__main__':unittest.main()
