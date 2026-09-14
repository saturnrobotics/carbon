"""The explicit CI override must not relax source or deployment safeguards."""

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_deploy import module

ROOT = Path(__file__).resolve().parents[3]


class SourceAdapter:
    def __init__(self, *, branch="saturn/main", dirty=False, published=True, archive=True):
        self.branch, self.dirty, self.published, self.archive = branch, dirty, published, archive
        self.calls = []

    def call(self, args, *, capture=False):
        self.calls.append(args)
        if args[0] == "git":
            if args[-2:] == ["branch", "--show-current"]:
                return self.branch
            if args[-2:] == ["status", "--porcelain"]:
                return " M file" if self.dirty else ""
            if "--git-path" in args:
                return "/nonexistent-synthetic-operation/" + args[-1]
            if args[-2:] == ["rev-parse", "HEAD"]:
                return "a" * 40
            if "ls-remote" in args:
                return ("a" if self.published else "b") * 40 + "\trefs/heads/saturn/main"
        if args[0] == "curl":
            if not self.archive:
                raise ValueError("source archive unavailable")
            return ""
        if args[0] == "gh":
            raise ValueError("synthetic CI unavailable")
        raise AssertionError(args[0])


class DeploymentForceTests(unittest.TestCase):
    def setUp(self):
        self.deploy = module()
        self.config = {"source_repo_url": "https://github.com/example/carbon"}

    def test_default_still_requires_workflow_success(self):
        with self.assertRaisesRegex(ValueError, "synthetic CI unavailable"):
            self.deploy.source_revision(self.config, SourceAdapter())

    def test_force_skips_ci_but_still_fetches_public_source(self):
        adapter = SourceAdapter()
        self.assertEqual(self.deploy.source_revision(self.config, adapter, force=True), "a" * 40)
        self.assertTrue(any(args[0] == "curl" for args in adapter.calls))
        self.assertFalse(any(args[0] == "gh" for args in adapter.calls))

    def test_force_still_rejects_dirty_wrong_branch_unpublished_or_unavailable_source(self):
        for arguments in ({"dirty": True}, {"branch": "feature"}, {"published": False}, {"archive": False}):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                self.deploy.source_revision(self.config, SourceAdapter(**arguments), force=True)

    def test_make_forwards_both_spellings_only_when_explicit(self):
        for target in ("deploy", "deploy-portal"):
            for flags in ([], ["FORCE=1"], ["--", "--force"]):
                with self.subTest(target=target, flags=flags):
                    result = subprocess.run(["make", "-n", target, *flags], cwd=ROOT, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    command = next(line for line in result.stdout.splitlines() if "--apply" in line)
                    self.assertEqual("--force" in command, bool(flags))

    def test_make_rejects_invalid_or_unrelated_force_before_running_recipes(self):
        for arguments in (
            ["deploy", "FORCE=yes"],
            ["deploy-check", "FORCE=1"],
            ["deploy", "help", "FORCE=1"],
            ["--", "--force"],
        ):
            result = subprocess.run(["make", "-n", *arguments], cwd=ROOT, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("--apply", result.stdout)

    def test_portal_cli_forwards_force_to_orchestration(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(self.deploy.sys, "argv", ["deploy.py", "--apply", "--force"]), patch.object(
                self.deploy, "read_config", return_value={}
            ), patch.object(self.deploy, "validate_config"), patch.object(
                self.deploy.shutil, "which", return_value="/tool"
            ), patch.object(self.deploy, "private_state", return_value=Path(directory)), patch.object(
                self.deploy, "select_psql", return_value="/tool/psql"
            ), patch.object(self.deploy, "orchestrate") as orchestrate:
                self.deploy.main()
            self.assertTrue(orchestrate.call_args.kwargs["force"])

    def test_force_requires_apply_before_reading_private_inputs(self):
        with patch.object(self.deploy.sys, "argv", ["deploy.py", "--check", "--force"]), patch.object(
            self.deploy, "read_config"
        ) as read:
            with self.assertRaises(SystemExit) as failure:
                self.deploy.main()
            self.assertEqual(failure.exception.code, 2)
            read.assert_not_called()

    def test_orchestration_forwards_force_before_any_provider_calls(self):
        adapter = SourceAdapter()
        with tempfile.TemporaryDirectory() as directory, patch.object(
            self.deploy, "source_revision", side_effect=ValueError("source sentinel")
        ) as source:
            with self.assertRaisesRegex(ValueError, "source sentinel"):
                self.deploy.orchestrate(self.config, Path(directory), apply=True, adapter=adapter, force=True)
            source.assert_called_once_with(self.config, adapter, force=True)
        self.assertEqual(adapter.calls, [])
