"""Exercise the branch workflow in disposable repositories, without network access."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HELPER = Path(__file__).resolve().with_name("fork.sh")
WRAPPER = HELPER.parents[3] / "scripts" / "sync-upstream.sh"


class ForkWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="carbon fork test ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "fork checkout"
        self.upstream = self.root / "upstream checkout"
        self.env = dict(os.environ)
        self.env.update({
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_EDITOR": "true",
        })
        self.run_git("init", "--initial-branch=main", str(self.upstream), cwd=self.root)
        self.configure(self.upstream)
        (self.upstream / "shared.txt").write_text("base\n")
        self.commit(self.upstream, "Initial fixture")
        self.run_git("clone", str(self.upstream), str(self.repo), cwd=self.root)
        self.configure(self.repo)
        self.run_git("remote", "rename", "origin", "upstream")
        self.run_git("switch", "-c", "saturn/main")
        self.base = self.run_git("rev-parse", "HEAD").stdout.strip()

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
        self.assert_success(self.helper("feature", "feature/example"))
        self.assert_branch("feature/example")
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), self.base)
        (self.repo / "feature.txt").write_text("feature\n")
        self.commit(self.repo, "Feature fixture")
        feature = self.run_git("rev-parse", "HEAD").stdout.strip()
        self.assert_success(self.helper("finish", "feature/example"))
        self.assert_branch("saturn/main")
        self.assertEqual(self.run_git("rev-parse", "HEAD^1").stdout.strip(), self.base)
        self.assertEqual(self.run_git("rev-parse", "HEAD^2").stdout.strip(), feature)
        self.assertEqual(self.run_git("rev-parse", "main").stdout.strip(), self.base)
        self.assertEqual(self.run_git("rev-parse", "feature/example").stdout.strip(), feature)

    def test_sync_fetches_and_merges_upstream_preserving_local_changes(self):
        (self.repo / "local.txt").write_text("customization\n")
        self.commit(self.repo, "Fork fixture change")
        previous = self.run_git("rev-parse", "HEAD").stdout.strip()
        upstream = self.upstream_change()
        self.assert_success(self.helper("sync"))
        self.assert_branch("saturn/main")
        self.assertEqual(self.run_git("rev-parse", "HEAD^1").stdout.strip(), previous)
        self.assertEqual(self.run_git("rev-parse", "HEAD^2").stdout.strip(), upstream)
        self.assertEqual((self.repo / "local.txt").read_text(), "customization\n")
        self.assertEqual((self.repo / "new-upstream.txt").read_text(), "upstream\n")
        merged = self.run_git("rev-parse", "HEAD").stdout.strip()
        self.assert_success(self.helper("sync"))
        self.assertEqual(self.run_git("rev-parse", "HEAD").stdout.strip(), merged)
        self.assertEqual(self.run_git("rev-parse", "main").stdout.strip(), self.base)

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
        self.assertEqual(self.run_git("rev-parse", "MERGE_HEAD").stdout.strip(), upstream)
        content = (self.repo / "shared.txt").read_text()
        self.assertIn("fork change", content)
        self.assertIn("upstream change", content)
        repeated = self.helper("sync")
        self.assertNotEqual(repeated.returncode, 0)
        self.assertIn("existing Git operation", repeated.stderr)
        self.run_git("merge", "--abort")
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
        self.assertEqual(self.run_git("rev-parse", "HEAD^2").stdout.strip(), upstream)
        self.assert_success(self.helper("--help", wrapper=True))


if __name__ == "__main__":
    unittest.main()
