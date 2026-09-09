"""Run the real disposable setup twice without resetting its database."""

import subprocess
import sys
import unittest
from pathlib import Path

from test_schema import sql


class FixtureSetupTests(unittest.TestCase):
    def test_repeated_setup_preserves_source_tables_and_separate_worker_role(self):
        command = [sys.executable, str(Path(__file__).with_name("setup-disposable.py"))]
        tables = (
            "SELECT 'public.\"knowledgeCommandReceipt\"'::regclass::oid, "
            "'public.\"knowledgeProcurementSchedule\"'::regclass::oid"
        )
        subprocess.run(command, check=True)
        first = sql(tables)
        subprocess.run(command, check=True)
        self.assertEqual(sql(tables), first)
        self.assertEqual(
            sql(
                "SELECT rolcanlogin AND rolbypassrls AND NOT rolsuper AND NOT rolinherit "
                "FROM pg_roles WHERE rolname='knowledge_test_scheduler'"
            ),
            "t",
        )
        self.assertEqual(
            sql(
                "SELECT rolbypassrls OR rolsuper FROM pg_roles "
                "WHERE rolname='knowledge_test_migrator'"
            ),
            "f",
        )
        self.assertEqual(
            sql(
                "SELECT has_schema_privilege('knowledge_test_scheduler','knowledge','USAGE')"
            ),
            "f",
        )
        self.assertEqual(
            sql(
                "SELECT has_table_privilege('knowledge_test_scheduler',"
                "'public.\"knowledgeProcurementSchedule\"','UPDATE')"
            ),
            "t",
        )


if __name__ == "__main__":
    unittest.main()
