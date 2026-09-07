import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from check_invoice import DATABASE_KEYS, check_environment, commands


class InvoiceCheckTest(unittest.TestCase):
    def test_default_does_not_use_inherited_database_or_provider_credentials(self):
        environment = {key: "postgresql://remote/private" for key in DATABASE_KEYS}
        environment["MERCURY_API_TOKEN"] = "example-test-token"
        result = check_environment(environment)
        self.assertTrue(all(key not in result for key in DATABASE_KEYS))
        self.assertEqual(result["MERCURY_API_TOKEN"], "")
        self.assertEqual(result["INVOICE_INTAKE_ENABLED"], "false")
        self.assertIn("--exclude", commands()[-1])

    def test_jobs_tests_build_the_shared_preset_first_in_both_modes(self):
        build = ["pnpm", "--filter", "@carbon/config", "build"]
        for integration in (False, True):
            with self.subTest(integration=integration):
                sequence = commands(integration)
                self.assertEqual(sequence[0], build)
                self.assertEqual(sequence[-1][1:3], ["--filter", "@carbon/jobs"])
                self.assertNotIn(build, commands(integration, erp_only=True))

    def test_integration_rejects_missing_remote_and_unix_socket_databases(self):
        for value in ("", "postgresql://example.com/invoices", "postgresql:///invoices"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                check_environment(dict.fromkeys(DATABASE_KEYS, value), True)
        result = check_environment(dict.fromkeys(DATABASE_KEYS, "postgresql://localhost:55432/invoice_test"), True)
        self.assertEqual(len(commands(True)), 3)
        self.assertTrue(result[DATABASE_KEYS[0]].endswith("invoice_test"))

    def test_app_environment_loading_is_ci_only(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "test.env"
            source.write_text('SUPABASE_DB_URL="postgresql://localhost:55432/invoice_test" # generated local URL\n')
            with self.assertRaises(ValueError):
                check_environment({}, True, source)
            result = check_environment({"GITHUB_ACTIONS": "true"}, True, source)
            self.assertTrue(all(result[key].endswith("invoice_test") for key in DATABASE_KEYS))


if __name__ == "__main__":
    unittest.main()
