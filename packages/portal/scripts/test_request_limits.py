import concurrent.futures
import unittest
from test_schema import sql

class RequestLimitTests(unittest.TestCase):
 def test_current_identity_and_explicit_quota_are_required(self):
  result=sql("BEGIN; SET LOCAL ROLE portal_read; SELECT portal_metering.admit_request('portal.query'); ROLLBACK",succeeds=False)
  self.assertEqual(result, 'BEGIN\nSET')
 def test_atomic_company_limit_survives_parallel_requests_without_redis(self):
  sql("INSERT INTO portal_metering.\"requestPolicy\" VALUES ('company-a','portal.query',1,1) ON CONFLICT (\"companyId\",endpoint) DO UPDATE SET \"userPerMinute\"=1,\"companyPerMinute\"=1; DELETE FROM portal_metering.\"requestWindow\" WHERE \"companyId\"='company-a' AND endpoint='portal.query';")
  statement="BEGIN; SET LOCAL ROLE portal_read; SET LOCAL portal.company_id='company-a'; SET LOCAL portal.actor_id='alice'; SET LOCAL portal.caller_id='web'; SELECT portal_metering.admit_request('portal.query'); COMMIT;"
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
   results=list(executor.map(lambda _:sql(statement),range(8)))
  self.assertEqual(sum(result.splitlines()[-2]=='t' for result in results),1)
  sql("DELETE FROM portal_metering.\"requestWindow\" WHERE \"companyId\"='company-a' AND endpoint='portal.query'; UPDATE portal_metering.\"requestPolicy\" SET \"userPerMinute\"=1000,\"companyPerMinute\"=10000 WHERE \"companyId\"='company-a' AND endpoint='portal.query';")
 def test_read_role_cannot_edit_limits(self):
  sql("SET ROLE portal_read; DELETE FROM portal_metering.\"requestPolicy\";",succeeds=False)

if __name__=='__main__':unittest.main()
