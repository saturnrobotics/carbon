"""Exercise persistent certificate identity with the installed TLS toolchain."""

from pathlib import Path
import subprocess
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


if __name__ == "__main__":
    unittest.main()
