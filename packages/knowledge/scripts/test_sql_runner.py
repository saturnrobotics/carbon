"""The negative SQL proof must distinguish rejection from broken infrastructure."""

import subprocess
import unittest
from unittest.mock import patch

from test_schema import sql


class SqlRunnerTests(unittest.TestCase):
    def run_sql(
        self, returncode, *, succeeds=False, sqlstate=None, stderr="synthetic error"
    ):
        inspected = subprocess.CompletedProcess(
            [], 0, '[{"Config":{"Labels":{"knowledge.disposable":"true"}}}]', ""
        )
        executed = subprocess.CompletedProcess([], returncode, "", stderr)
        with patch("test_schema.subprocess.run", side_effect=[inspected, executed]):
            return sql("SELECT 1", succeeds=succeeds, sqlstate=sqlstate)

    def test_expected_sql_error_is_accepted(self):
        self.assertEqual(self.run_sql(3), "")

    def test_permission_denial_requires_the_expected_sqlstate(self):
        self.assertEqual(
            self.run_sql(
                3, sqlstate="42501", stderr="ERROR:  42501: permission denied"
            ),
            "",
        )
        for actual in ("42601", "42883", "57014"):
            with self.subTest(actual=actual):
                with self.assertRaisesRegex(AssertionError, "SQLSTATE 42501"):
                    self.run_sql(
                        3, sqlstate="42501", stderr=f"ERROR:  {actual}: other error"
                    )

    def test_success_is_not_accepted_as_denial(self):
        with self.assertRaisesRegex(AssertionError, "Forbidden SQL"):
            self.run_sql(0)

    def test_infrastructure_failures_are_not_accepted_as_denial(self):
        for returncode in (1, 2, 125, 137):
            with self.subTest(returncode=returncode):
                with self.assertRaisesRegex(AssertionError, "SQL error"):
                    self.run_sql(returncode)

    def test_required_success_still_rejects_sql_errors(self):
        with self.assertRaises(AssertionError):
            self.run_sql(3, succeeds=True)


if __name__ == "__main__":
    unittest.main()
