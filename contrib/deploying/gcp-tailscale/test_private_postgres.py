"""Exercise persistent certificate identity with the installed TLS toolchain."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import private_postgres


class CertificateIdentityTests(unittest.TestCase):
    def assert_toolchain_rejected_without_state_changes(self, response):
        for existing in (False, True):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary) / "tls"
                if existing:
                    directory.mkdir(mode=0o750)
                    for name in ("ca.crt", "ca.key", "server.crt", "server.key"):
                        path = directory / name
                        path.write_text("synthetic preserved material")
                        path.chmod(0o640)
                before = {path.name: (path.read_bytes(), path.stat().st_mode)
                          for path in directory.iterdir()} if existing else None
                directory_mode = directory.stat().st_mode if existing else None
                error = None
                options = {"side_effect": response} if isinstance(response, OSError) else {"return_value": response}
                with patch.object(private_postgres, "openssl", **options):
                    try:
                        private_postgres.certificates(directory, "10.73.0.2")
                    except Exception as caught:
                        error = caught
                self.assertIsInstance(error, ValueError)
                self.assertRegex(str(error), "OpenSSL 3 or later.*PATH")
                if existing:
                    self.assertEqual(before, {path.name: (path.read_bytes(), path.stat().st_mode)
                                              for path in directory.iterdir()})
                    self.assertEqual(directory_mode, directory.stat().st_mode)
                else:
                    self.assertFalse(directory.exists())

    def test_unsupported_tls_tools_are_rejected_before_certificate_state_changes(self):
        for version in ("LibreSSL 3.3.6", "OpenSSL 1.1.1w", "OpenSSL 2.0.0",
                        "OpenSSL 3.invalid", "unrecognized TLS tool", ""):
            with self.subTest(version=version):
                self.assert_toolchain_rejected_without_state_changes(
                    subprocess.CompletedProcess(["openssl", "version"], 0, version, ""))

    def test_unavailable_tls_tools_are_rejected_before_certificate_state_changes(self):
        for response in (FileNotFoundError("synthetic missing executable"),
                         PermissionError("synthetic inaccessible executable"),
                         subprocess.CompletedProcess(["openssl", "version"], 1, "OpenSSL 3.0.0", "")):
            with self.subTest(response=type(response).__name__):
                self.assert_toolchain_rejected_without_state_changes(response)

    def test_address_mismatch_is_rejected_without_replacing_persistent_material(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            private_postgres.certificates(directory, "10.73.0.2")
            before = {path.name: path.read_bytes() for path in directory.iterdir()}

            private_postgres.certificates(directory, "10.73.0.2")
            self.assertEqual(before, {path.name: path.read_bytes() for path in directory.iterdir()})

            with self.assertRaisesRegex(ValueError, "differs from"):
                private_postgres.certificates(directory, "10.73.0.3")
            self.assertEqual(before, {path.name: path.read_bytes() for path in directory.iterdir()})


    def verifies(self, directory, address):
        return subprocess.run(["openssl", "verify", "-CAfile", str(directory / "ca.crt"), "-verify_ip", address,
                               str(directory / "server.crt")], capture_output=True).returncode == 0

    def test_adoption_keeps_the_ca_and_reissues_only_for_a_moved_address(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            private_postgres.certificates(directory, "10.73.0.2")
            before = {path.name: path.read_bytes() for path in directory.iterdir()}

            self.assertFalse(private_postgres.reissue(directory, "10.73.0.2"))
            self.assertEqual(before, {path.name: path.read_bytes() for path in directory.iterdir()})

            self.assertTrue(private_postgres.reissue(directory, "10.73.8.2"))
            after = {path.name: path.read_bytes() for path in directory.iterdir()}
            self.assertEqual(set(after), set(before))
            for name in ("ca.crt", "ca.key"):
                self.assertEqual(after[name], before[name])
            for name in ("server.crt", "server.key"):
                self.assertNotEqual(after[name], before[name])
                self.assertEqual((directory / name).stat().st_mode & 0o777, 0o600)
            self.assertTrue(self.verifies(directory, "10.73.8.2"))
            self.assertFalse(self.verifies(directory, "10.73.0.2"))

            # Deployment accepts the adopted address but never follows another change itself.
            private_postgres.certificates(directory, "10.73.8.2")
            self.assertEqual(after, {path.name: path.read_bytes() for path in directory.iterdir()})
            with self.assertRaisesRegex(ValueError, "differs from"):
                private_postgres.certificates(directory, "10.73.9.9")
            self.assertEqual(after, {path.name: path.read_bytes() for path in directory.iterdir()})

    def test_adoption_without_tls_state_issues_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "tls"
            with patch.object(private_postgres, "openssl", side_effect=AssertionError("issued TLS material")):
                self.assertFalse(private_postgres.reissue(directory, "10.73.8.2"))
            self.assertFalse(directory.exists())

    def test_adoption_refuses_incomplete_or_foreign_tls_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            private_postgres.certificates(directory, "10.73.0.2")
            (directory / "ca.key").unlink()
            before = {path.name: path.read_bytes() for path in directory.iterdir()}
            with self.assertRaisesRegex(ValueError, "Incomplete"):
                private_postgres.reissue(directory, "10.73.8.2")
            self.assertEqual(before, {path.name: path.read_bytes() for path in directory.iterdir()})
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            private_postgres.certificates(Path(first), "10.73.0.2")
            private_postgres.certificates(Path(second), "10.73.0.2")
            (Path(first) / "server.crt").write_bytes((Path(second) / "server.crt").read_bytes())
            before = {path.name: path.read_bytes() for path in Path(first).iterdir()}
            with self.assertRaises(subprocess.CalledProcessError):
                private_postgres.reissue(Path(first), "10.73.8.2")
            self.assertEqual(before, {path.name: path.read_bytes() for path in Path(first).iterdir()})

    def test_adoption_command_requires_a_private_address(self):
        script = Path(private_postgres.__file__)
        with tempfile.TemporaryDirectory() as temporary:
            for address in ("203.0.113.5", "100.64.0.1", "not-an-address"):
                with self.subTest(address=address):
                    result = subprocess.run([sys.executable, str(script), "adopt", temporary, address], capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Cannot adopt", result.stderr)
            result = subprocess.run([sys.executable, str(script), "adopt", temporary, "10.73.8.2"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("needs no change", result.stdout)
            self.assertEqual(list(Path(temporary).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
