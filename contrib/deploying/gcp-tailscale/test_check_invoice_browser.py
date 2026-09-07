from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from check_invoice import DATABASE_KEYS
from check_invoice_browser import browser_environment


class InvoiceBrowserCheckTest(unittest.TestCase):
    def environment(self):
        return {
            **dict.fromkeys(DATABASE_KEYS, "postgresql://localhost:55432/invoice_test"),
            "GITHUB_ACTIONS": "true",
            "ERP_URL": "http://localhost:3000",
            "SUPABASE_URL": "http://localhost:54321",
            "SUPABASE_DB_URL": "postgresql://localhost:55432/invoice_test",
            "SUPABASE_SERVICE_ROLE_KEY": "synthetic-local-test-key",
            "REDIS_URL": "redis://localhost:6379",
        }

    def test_uses_new_private_artifacts_and_unique_synthetic_login(self):
        with TemporaryDirectory() as directory:
            first = browser_environment(self.environment(), Path(directory) / "first")
            second = browser_environment(self.environment(), Path(directory) / "second")
            self.assertNotEqual(first["INVOICE_BROWSER_EMAIL"], second["INVOICE_BROWSER_EMAIL"])
            self.assertEqual(first["DEV_BYPASS_EMAIL"], first["INVOICE_BROWSER_EMAIL"])
            self.assertEqual(Path(first["INVOICE_BROWSER_DIRECTORY"]).stat().st_mode & 0o777, 0o700)
            with self.assertRaisesRegex(ValueError, "new artifact"):
                browser_environment(self.environment(), Path(directory) / "first")

    def test_rejects_remote_services_before_creating_artifacts(self):
        with TemporaryDirectory() as directory:
            for key in ("ERP_URL", "SUPABASE_URL", "SUPABASE_DB_URL", "REDIS_URL"):
                target = Path(directory) / key
                environment = self.environment()
                environment[key] = environment[key].replace("localhost", "example.com")
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, "localhost"):
                    browser_environment(environment, target)
                self.assertFalse(target.exists())

    def test_local_artifacts_cannot_be_written_to_tracked_paths(self):
        with TemporaryDirectory() as directory:
            environment = self.environment()
            environment.pop("GITHUB_ACTIONS")
            with self.assertRaisesRegex(ValueError, "ignored"):
                browser_environment(environment, Path(directory) / "public-artifacts")


if __name__ == "__main__":
    unittest.main()
