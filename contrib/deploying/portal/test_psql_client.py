"""Select the operator client without weakening PostgreSQL TLS verification."""

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_deploy import module


class PsqlClientTests(unittest.TestCase):
    def setUp(self):
        self.deploy = module()

    def select(self):
        self.assertTrue(
            callable(getattr(self.deploy, "select_psql", None)), "Deployment must select a compatible PostgreSQL client"
        )
        return self.deploy.select_psql()

    def test_compatible_path_client_is_kept(self):
        for version in (
            "16.10",
            "18.6 (Homebrew)",
            "16.10 (Ubuntu 16.10-1.pgdg24.04+1)",
            "17.6 (Debian 17.6-1.pgdg120+1)",
        ):
            with self.subTest(version=version):
                with patch.object(self.deploy.shutil, "which", return_value="/tools/psql"), patch.object(
                    self.deploy.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], 0, f"psql (PostgreSQL) {version}\n"),
                ) as run:
                    self.assertEqual(self.select(), "/tools/psql")
                    self.assertEqual(run.call_count, 1)

    def test_old_or_missing_client_uses_installed_homebrew_libpq(self):
        for existing in ("/old/psql", None):
            with self.subTest(existing=existing):

                def which(name):
                    return existing if name == "psql" else "/tools/brew"

                def run(args, **kwargs):
                    output = (
                        "psql (PostgreSQL) 14.17"
                        if args[0] == "/old/psql"
                        else "/tools/libpq"
                        if args[0] == "/tools/brew"
                        else "psql (PostgreSQL) 18.6"
                    )
                    return subprocess.CompletedProcess(args, 0, output)

                with patch.object(self.deploy.shutil, "which", side_effect=which), patch.object(
                    self.deploy.subprocess, "run", side_effect=run
                ):
                    self.assertEqual(self.select(), "/tools/libpq/bin/psql")

    def test_incompatible_or_unreadable_versions_fail_with_actionable_error(self):
        for output in ("psql (PostgreSQL) 14.17", "unknown", "psql (PostgreSQL) 18beta1"):
            with self.subTest(output=output), patch.object(
                self.deploy.shutil, "which", side_effect=lambda name: "/old/psql" if name == "psql" else None
            ), patch.object(self.deploy.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)):
                with self.assertRaisesRegex(ValueError, "PostgreSQL 16.*brew install libpq"):
                    self.select()

    def test_selected_client_is_used_without_exposing_its_path(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "commands.log"
            self.assertTrue(callable(getattr(self.deploy, "select_psql", None)), "Missing client selection")
            with self.deploy.Commands(log, psql="/private/client/psql") as adapter:
                with patch.object(
                    self.deploy.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "t")
                ) as run:
                    self.assertEqual(adapter.call(["psql", "service=example", "-c", "SELECT 1"], capture=True), "t")
                    self.assertEqual(run.call_args.args[0][0], "/private/client/psql")
            self.assertNotIn("/private/client", log.read_text())
