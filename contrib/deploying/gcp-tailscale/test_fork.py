"""Exercise the branch workflow in disposable repositories, without network access."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = Path(__file__).resolve().with_name("fork.sh")
WRAPPER = HELPER.parents[3] / "scripts" / "sync-upstream.sh"


class ForkWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="carbon fork test ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "fork checkout"
        self.upstream = self.root / "upstream checkout"
        self.env = dict(os.environ)
        self.env.update({
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_EDITOR": "true",
            "TMPDIR": str(self.root),
        })
        self.run_git("init", "--initial-branch=main", str(self.upstream), cwd=self.root)
        self.configure(self.upstream)
        (self.upstream / "shared.txt").write_text("base\n")
        (self.upstream / ".fork").mkdir()
        (self.upstream / ".fork/verify.py").write_text(
            "from pathlib import Path\nimport sys\n"
            "sys.exit(1 if Path('fail-preflight').exists() else 0)\n"
        )
        self.commit(self.upstream, "Initial fixture")
        self.run_git("clone", str(self.upstream), str(self.repo), cwd=self.root)
        self.configure(self.repo)
        self.run_git("remote", "rename", "origin", "upstream")
        self.run_git("switch", "-c", "saturn/main")
        self.base = self.run_git("rev-parse", "HEAD").stdout.strip()

    def fake_verification(self, *, success):
        """Mock only the API verification process; Git operations remain real."""
        tools = self.root / "verification-tools"
        tools.mkdir(exist_ok=True)
        executable = tools / "python3"
        executable.write_text(
            f"#!{sys.executable}\nimport os, sys\n"
            "from pathlib import Path\n"
            "if Path(sys.argv[1]).name == 'verify_source.py':\n"
            f"    Path({str(self.root / 'verification-args')!r}).write_text('\\n'.join(sys.argv[2:]))\n"
            f"    sys.exit({0 if success else 1})\n"
            f"os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])\n"
        )
        executable.chmod(0o755)
        self.env["PATH"] = str(tools) + os.pathsep + os.environ["PATH"]

    def candidate_worktree(self):
        worktrees = self.run_git("worktree", "list", "--porcelain").stdout
        return next(Path(line.removeprefix("worktree ")) for line in worktrees.splitlines()
                    if line.startswith("worktree ") and line != f"worktree {self.repo}")

    def run_git(self, *args, cwd=None, check=True):
        return subprocess.run(
            ["git", *args], cwd=cwd or self.repo, env=self.env,
            text=True, capture_output=True, check=check,
        )

    def configure(self, repo):
        self.run_git("config", "user.name", "Test Operator", cwd=repo)
        self.run_git("config", "user.email", "operator@example.com", cwd=repo)
        self.run_git("config", "commit.gpgsign", "false", cwd=repo)

    def commit(self, repo, message):
        self.run_git("add", "--all", cwd=repo)
        self.run_git("commit", "-m", message, cwd=repo)

    def helper(self, *args, wrapper=False):
        result = subprocess.run(
            ["bash", str(WRAPPER if wrapper else HELPER), *args],
            cwd=self.repo, env=self.env, text=True, capture_output=True,
        )
        return result

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_branch(self, name):
        self.assertEqual(self.run_git("branch", "--show-current").stdout.strip(), name)

    def upstream_change(self, filename="new-upstream.txt", value="upstream\n"):
        (self.upstream / filename).write_text(value)
        self.commit(self.upstream, "Upstream fixture change")
        return self.run_git("rev-parse", "HEAD", cwd=self.upstream).stdout.strip()

    def test_feature_starts_at_deployment_branch_and_finishes_without_rewriting(self):
        self.fake_verification(success=True)
        self.assert_success(self.helper("feature", "feature/example"))
        self.assert_branch("feature/example")
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), self.base)
        (self.repo / "feature.txt").write_text("feature\n")
        self.commit(self.repo, "Feature fixture")
        feature = self.run_git("rev-parse", "HEAD").stdout.strip()
        self.assert_success(self.helper("finish", "feature/example"))
        self.assert_branch("saturn/main")
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), feature)
        self.assertEqual(self.run_git("rev-parse", "main").stdout.strip(), self.base)
        self.assertEqual(self.run_git("rev-parse", "feature/example").stdout.strip(), feature)

    def test_sync_fetches_and_merges_upstream_preserving_local_changes(self):
        (self.repo / "local.txt").write_text("customization\n")
        self.commit(self.repo, "Fork fixture change")
        previous = self.run_git("rev-parse", "HEAD").stdout.strip()
        upstream = self.upstream_change()
        self.assert_success(self.helper("sync"))
        self.assert_branch("saturn/main")
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), previous)
        candidate = self.candidate_worktree()
        self.assertEqual(self.run_git("rev-parse", "HEAD^1", cwd=candidate).stdout.strip(), previous)
        self.assertEqual(self.run_git("rev-parse", "HEAD^2", cwd=candidate).stdout.strip(), upstream)
        self.assertEqual((self.repo / "local.txt").read_text(), "customization\n")
        self.assertFalse((self.repo / "new-upstream.txt").exists())
        self.assertEqual((candidate / "new-upstream.txt").read_text(), "upstream\n")
        self.assertEqual(self.run_git("status", "--porcelain").stdout, "")
        repeated = self.helper("sync")
        self.assertNotEqual(repeated.returncode, 0)
        self.assertIn("already exists", repeated.stderr)
        self.assertEqual(self.run_git("rev-parse", "main").stdout.strip(), self.base)

    def test_promotion_rejects_missing_verification_without_switching(self):
        self.fake_verification(success=False)
        self.assert_success(self.helper("feature", "feature/unverified"))
        (self.repo / "feature.txt").write_text("candidate\n")
        self.commit(self.repo, "Unverified fixture")
        candidate = self.run_git("rev-parse", "HEAD").stdout.strip()
        result = self.helper("finish", "feature/unverified")
        self.assertNotEqual(result.returncode, 0)
        self.assert_branch("feature/unverified")
        self.assertEqual(self.run_git("rev-parse", "saturn/main").stdout.strip(), self.base)
        self.assertIn(candidate, (self.root / "verification-args").read_text())

    def test_promotion_rejects_a_candidate_missing_new_integration_commits(self):
        self.fake_verification(success=True)
        self.assert_success(self.helper("feature", "feature/outdated"))
        (self.repo / "feature.txt").write_text("candidate\n")
        self.commit(self.repo, "Candidate fixture")
        self.run_git("switch", "saturn/main")
        (self.repo / "stable.txt").write_text("new stable work\n")
        self.commit(self.repo, "New integration fixture")
        stable = self.run_git("rev-parse", "HEAD").stdout.strip()
        result = self.helper("promote", "feature/outdated")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("include the current saturn/main", result.stderr)
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), stable)
        self.assertFalse((self.root / "verification-args").exists())

    def test_verified_sync_candidate_promotes_without_creating_untested_merge_sha(self):
        self.fake_verification(success=True)
        self.upstream_change()
        self.assert_success(self.helper("sync"))
        worktree = self.candidate_worktree()
        branch = self.run_git("branch", "--show-current", cwd=worktree).stdout.strip()
        revision = self.run_git("rev-parse", "HEAD", cwd=worktree).stdout.strip()
        self.assert_success(self.helper("promote", branch))
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), revision)
        self.assertIn(revision, (self.root / "verification-args").read_text())

    def test_failed_preflight_stops_before_fetch_or_candidate_creation(self):
        self.upstream_change()
        (self.repo / "fail-preflight").write_text("fixture failure\n")
        self.commit(self.repo, "Preflight failure fixture")
        result = self.helper("sync")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.run_git("rev-parse", "upstream/main").stdout.strip(), self.base)
        self.assertEqual(self.run_git("worktree", "list", "--porcelain").stdout.count("worktree "), 1)

    def test_dirty_and_wrong_branch_fail_without_switching_or_fetching(self):
        self.upstream_change()
        (self.repo / "untracked.txt").write_text("pending review\n")
        result = self.helper("sync")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Working tree must be clean", result.stderr)
        self.assertEqual(self.run_git("rev-parse", "upstream/main").stdout.strip(), self.base)
        (self.repo / "untracked.txt").unlink()
        self.run_git("switch", "main")
        result = self.helper("sync")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("git switch saturn/main", result.stderr)
        self.assert_branch("main")
        self.assertEqual(self.run_git("rev-parse", "upstream/main").stdout.strip(), self.base)

    def test_conflict_preserves_both_versions_and_stops_pending_merge(self):
        (self.repo / "shared.txt").write_text("fork change\n")
        self.commit(self.repo, "Fork conflict fixture")
        previous = self.run_git("rev-parse", "HEAD").stdout.strip()
        upstream = self.upstream_change("shared.txt", "upstream change\n")
        result = self.helper("sync")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Merge did not finish", result.stderr)
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), previous)
        candidate = self.candidate_worktree()
        self.assertEqual(self.run_git("rev-parse", "MERGE_HEAD", cwd=candidate).stdout.strip(), upstream)
        self.assertEqual(self.run_git("status", "--porcelain").stdout, "")
        self.assertEqual((self.repo / "shared.txt").read_text(), "fork change\n")
        content = (candidate / "shared.txt").read_text()
        self.assertIn("fork change", content)
        self.assertIn("upstream change", content)
        repeated = self.helper("sync")
        self.assertNotEqual(repeated.returncode, 0)
        self.assertIn("already exists", repeated.stderr)
        self.run_git("merge", "--abort", cwd=candidate)
        self.assertEqual((self.repo / "shared.txt").read_text(), "fork change\n")

    def test_pre_merge_hook_is_respected(self):
        self.upstream_change()
        hook = self.repo / ".git" / "hooks" / "pre-merge-commit"
        hook.write_text("#!/bin/sh\nprintf 'fixture hook rejected merge\\n' >&2\nexit 1\n")
        hook.chmod(0o755)
        result = self.helper("sync")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixture hook rejected merge", result.stderr)
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), self.base)

    def test_invalid_or_reserved_feature_names_are_rejected(self):
        for branch in ["main", "saturn/main", "--force", "bad..name", "HEAD"]:
            with self.subTest(branch=branch):
                self.assertNotEqual(self.helper("feature", branch).returncode, 0)
                self.assert_branch("saturn/main")
                self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), self.base)

    def test_missing_feature_does_not_switch_current_branch(self):
        self.assert_success(self.helper("feature", "feature/example"))
        self.assertNotEqual(self.helper("finish", "feature/missing").returncode, 0)
        self.assert_branch("feature/example")

    def test_compatibility_wrapper_merges_and_accepts_help(self):
        upstream = self.upstream_change()
        self.assert_success(self.helper(wrapper=True))
        candidate = self.candidate_worktree()
        self.assertEqual(self.run_git("rev-parse", "HEAD^2", cwd=candidate).stdout.strip(), upstream)
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), self.base)
        self.assert_success(self.helper("--help", wrapper=True))


if __name__ == "__main__":
    unittest.main()
