from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import signal
import subprocess
import traceback
import unittest
from unittest.mock import MagicMock, patch

from check_invoice import DATABASE_KEYS, ROOT
from check_invoice_browser import browser_environment, run


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

    def test_failed_commands_identify_phase_without_leaking_private_details(self):
        private = "synthetic-private-command-and-output"
        cases = (
            ("fixture", "seed", "fixture/seed"),
            ("review", "approve", "browser/review/approve"),
            ("preservation", "initial", "browser/preservation/initial"),
        )
        for script, phase, label in cases:
            for failure in (
                subprocess.CalledProcessError(1, [private], output=private, stderr=private),
                subprocess.TimeoutExpired([private], 1, output=private, stderr=private),
                OSError(private),
            ):
                with self.subTest(label=label, error=type(failure).__name__), TemporaryDirectory() as directory:
                    root = Path(directory)
                    for name in ("invoice-browser-verification.json", "invoice-browser-state.json"):
                        (root / name).write_text("{}")
                    commands = []
                    logs = []

                    def command(args, **kwargs):
                        commands.append(args)
                        logs.append(kwargs["stdout"])
                        kwargs["stdout"].write(private)
                        current_phase = kwargs["env"].get("INVOICE_BROWSER_PHASE")
                        if (script == "fixture" and current_phase == phase) or (
                            script != "fixture" and args[-2:] == [
                                "apps/erp/test/invoice-browser/" + script + ".mjs", phase
                            ]
                        ):
                            raise failure

                    app = MagicMock(pid=12345)
                    app.poll.return_value = None
                    response = MagicMock()
                    response.__enter__.return_value.status = 200
                    probe = MagicMock()
                    probe.__enter__.return_value.connect_ex.return_value = 1
                    output = StringIO()
                    with (
                        patch("check_invoice_browser.socket.socket", return_value=probe),
                        patch("check_invoice_browser.subprocess.Popen", return_value=app),
                        patch("check_invoice_browser.urlopen", return_value=response),
                        patch("check_invoice_browser.subprocess.run", side_effect=command),
                        patch("check_invoice_browser.os.killpg") as killpg,
                        redirect_stdout(output),
                        redirect_stderr(output),
                        self.assertRaises(Exception) as caught,
                    ):
                        run(self.environment(), root, start_app=True)
                    self.assertIsInstance(caught.exception, ValueError)
                    self.assertEqual(str(caught.exception), "Browser acceptance failed during " + label + "; inspect the private browser log")
                    self.assertIn("Browser acceptance phase: " + label, output.getvalue())
                    self.assertNotIn("acceptance passed", output.getvalue())
                    self.assertNotIn(private, output.getvalue() + "".join(traceback.format_exception(caught.exception)))
                    self.assertEqual(len(commands), {"seed": 2, "approve": 5, "initial": 9}[phase])
                    killpg.assert_called_once_with(app.pid, signal.SIGTERM)
                    app.wait.assert_called_once_with(timeout=15)
                    self.assertTrue(all(log.closed for log in logs))
                    self.assertEqual((root / "browser.log").stat().st_mode & 0o777, 0o600)

    def test_generated_crbn_login_does_not_override_explicit_browser_identity(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "apps/erp"
            app.mkdir(parents=True)
            source = root / ".env.local"
            original = "DEV_BYPASS_EMAIL=test@carbon.ms\n"
            source.write_text(original)
            script = """
import {applyDotenvToProcessEnv} from './packages/dev/vite.js';
process.env.DEV_BYPASS_EMAIL='invoice-browser-synthetic@example.com';
applyDotenvToProcessEnv('development',process.argv[1]);
if(process.env.DEV_BYPASS_EMAIL!=='invoice-browser-synthetic@example.com')
  throw Error('Generated development login replaced the explicit browser identity');
"""
            subprocess.run(["node", "--input-type=module", "-e", script, str(app)], cwd=ROOT, check=True, capture_output=True, text=True)
            self.assertEqual(source.read_text(), original)


if __name__ == "__main__":
    unittest.main()
