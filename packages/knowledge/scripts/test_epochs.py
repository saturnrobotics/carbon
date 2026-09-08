import unittest
from test_schema import sql

class EpochTests(unittest.TestCase):
 def test_grant_revoke_advances_acl_epoch_without_application_cooperation(self):
  result=sql('BEGIN; SELECT "aclEpoch" FROM knowledge.source WHERE id=\'source-a\'; UPDATE knowledge."grant" SET "revokedAt"=now(),version=version+1 WHERE id=\'grant-a-source\'; SELECT "aclEpoch" FROM knowledge.source WHERE id=\'source-a\'; ROLLBACK')
  values=[int(line) for line in result.splitlines() if line.isdigit()]
  self.assertEqual(values[1],values[0]+1)
 def test_new_matching_document_advances_content_epoch(self):
  result=sql('BEGIN; SELECT "contentEpoch" FROM knowledge.source WHERE id=\'source-a\'; UPDATE knowledge.document SET title=\'New title\',version=version+1 WHERE id=\'doc-a\'; SELECT "contentEpoch" FROM knowledge.source WHERE id=\'source-a\'; ROLLBACK')
  values=[int(line) for line in result.splitlines() if line.isdigit()]
  self.assertEqual(values[1],values[0]+1)
 def test_provider_policy_change_advances_acl_epoch(self):
  result=sql('BEGIN; SELECT "aclEpoch" FROM knowledge.source WHERE id=\'source-a\'; UPDATE knowledge.source SET "providerPolicy"=\'{"allowedProviders":[]}\',version=version+1 WHERE id=\'source-a\'; SELECT "aclEpoch" FROM knowledge.source WHERE id=\'source-a\'; ROLLBACK')
  values=[int(line) for line in result.splitlines() if line.isdigit()]
  self.assertEqual(values[1],values[0]+1)
if __name__=='__main__':unittest.main()
