"""Behavior tests for the upstream integration controller, using disposable Git repos."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import sync_agent


class SyncAgentEntryTests(unittest.TestCase):
    def test_make_sync_launches_the_controller(self):
        root = Path(__file__).resolve().parents[3]
        makefile = (root / "Makefile").read_text()
        recipe = makefile.split("\nsync:\n", 1)[1].split("\n\n", 1)[0]
        self.assertIn("sync_agent.py", recipe)


class AgentProtocolTests(unittest.TestCase):
    def test_accepts_only_complete_typed_protocol(self):
        value = {
            "action": "stage",
            "paths": ["shared.txt"],
            "summary": "Resolved both changes",
        }
        self.assertEqual(sync_agent.validate_action(value), value)
        for bad in (
            {},
            {**value, "action": "push"},
            {**value, "paths": "shared.txt"},
            {**value, "approved": True},
            {**value, "summary": 3},
            {**value, "paths": ["shared.txt", "shared.txt"]},
            {**value, "action": "ready"},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                sync_agent.validate_action(bad)

    def test_paths_are_literal_relative_and_do_not_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "outside").symlink_to(root.parent, target_is_directory=True)
            self.assertEqual(
                sync_agent.safe_paths(root, ["source file.txt"]), ["source file.txt"]
            )
            for name in (
                "../private",
                "/etc/passwd",
                ":(top)*",
                "./file",
                "outside/secret",
                ".git/config",
                "a/../b",
                ".fork/local/private",
                "a\nfile",
                "",
            ):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    sync_agent.safe_paths(root, [name])

    def test_drops_credentials_and_tool_overrides(self):
        with patch.dict(
            os.environ,
            {
                "GH_TOKEN": "synthetic",
                "DATABASE_URL": "synthetic",
                "GIT_DIR": "elsewhere",
                "NODE_OPTIONS": "--require=elsewhere",
            },
        ):
            environment = sync_agent.clean_environment()
        for name in ("GH_TOKEN", "DATABASE_URL", "GIT_DIR", "NODE_OPTIONS"):
            self.assertNotIn(name, environment)
        self.assertIn("PATH", environment)

    def test_private_directory_itself_is_not_a_stageable_path(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                sync_agent.safe_paths(Path(directory), [".fork/local"])


class ControllerGitTests(unittest.TestCase):
    """Only the remote attestation boundary is mocked; all Git operations are real."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sync agent fixture ")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.root = self.directory / "original checkout"
        self.root.mkdir()
        self.home = self.directory / "isolated home"
        self.home.mkdir()
        self.environment = patch.dict(
            os.environ,
            {
                "HOME": str(self.home),
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": os.devnull,
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.git(self.root, "init", "-b", "saturn/main")
        self.git(self.root, "config", "user.name", "Example Developer")
        self.git(self.root, "config", "user.email", "developer@example.com")
        self.git(self.root, "config", "commit.gpgsign", "false")
        self.git(
            self.root, "config", "core.hooksPath", str(self.directory / "empty hooks")
        )
        self.write(self.root, "shared.txt", "original\n")
        self.write(self.root, ".gitignore", ".fork/local/\n")
        self.write(self.root, ".fork/verify.py", "# trusted verification fixture\n")
        self.git(self.root, "add", "--", "shared.txt", ".gitignore", ".fork/verify.py")
        self.git(self.root, "commit", "-m", "Initial fixture")
        self.git(
            self.root, "remote", "add", "origin", "git@github.com:example/fork.git"
        )
        self.git(self.root, "switch", "-c", "fixture-upstream")
        self.write(self.root, "upstream.txt", "upstream feature\n")
        self.git(self.root, "add", "--", "upstream.txt")
        self.git(self.root, "commit", "-m", "Upstream feature")
        self.upstream = self.git(self.root, "rev-parse", "HEAD")
        self.git(self.root, "switch", "saturn/main")
        self.write(self.root, "fork.txt", "fork feature\n")
        self.git(self.root, "add", "--", "fork.txt")
        self.git(self.root, "commit", "-m", "Fork feature")
        self.base = self.git(self.root, "rev-parse", "HEAD")
        self.candidate = self.directory / "candidate worktree"
        self.branch = "sync/upstream-fixture"
        self.git(
            self.root,
            "worktree",
            "add",
            "-b",
            self.branch,
            str(self.candidate),
            self.base,
        )
        self.git(self.candidate, "merge", "--no-ff", "--no-edit", self.upstream)
        self.head = self.git(self.candidate, "rev-parse", "HEAD")
        self.controller = sync_agent.Controller(self.root)
        self.controller.state = {
            "version": 1,
            "root": str(self.root),
            "base": self.base,
            "upstream": self.upstream,
            "head": self.head,
            "branch": self.branch,
            "candidate": str(self.candidate),
            "origin": "git@github.com:example/fork.git",
            "phase": "repair",
            "turns": 0,
            "feedback": "Synthetic fixture",
        }
        self.controller.save()

    def test_original_pending_merge_is_not_a_clean_promotion_target(self):
        location = Path(self.git(self.root, "rev-parse", "--git-path", "MERGE_HEAD"))
        if not location.is_absolute():
            location = self.root / location
        location.write_text(self.upstream + "\n")
        self.assertEqual(self.git(self.root, "status", "--porcelain"), "")
        with self.assertRaisesRegex(ValueError, "Git operation"):
            self.controller.assert_original()

    def test_candidate_unrecorded_merge_is_rejected_before_edits(self):
        location = Path(
            self.git(self.candidate, "rev-parse", "--git-path", "MERGE_HEAD")
        )
        if not location.is_absolute():
            location = self.candidate / location
        location.write_text(self.base + "\n")
        with self.assertRaisesRegex(ValueError, "Git operation"):
            self.controller.assert_candidate()

    def git(self, root, *arguments):
        result = subprocess.run(
            ["git", "-C", str(root), *arguments],
            capture_output=True,
            text=True,
            check=True,
            timeout=20,
        )
        return result.stdout.strip()

    def write(self, root, name, content):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit_candidate(self, name="repair.txt", content="reviewed repair\n"):
        self.write(self.candidate, name, content)
        self.git(self.candidate, "add", "--", name)
        self.git(self.candidate, "commit", "-m", "Repair fixture")
        return self.git(self.candidate, "rev-parse", "HEAD")

    def assert_stable_unchanged(self):
        self.assertEqual(self.git(self.root, "rev-parse", "saturn/main"), self.base)
        self.assertFalse(self.git(self.root, "status", "--porcelain"))

    def test_stage_treats_wildcards_spaces_and_options_as_literal_names(self):
        requested = ["source*.txt", "source file.txt", "--all"]
        for name in [*requested, "source-other.txt"]:
            self.write(self.candidate, name, "synthetic change\n")
        self.controller.stage(requested)
        staged = self.git(
            self.candidate, "diff", "--cached", "--name-only"
        ).splitlines()
        self.assertEqual(set(staged), set(requested))
        self.assertEqual(sync_agent.changed_paths(self.candidate), ["source-other.txt"])
        self.assert_stable_unchanged()

    def test_stage_records_a_reviewed_deletion(self):
        (self.candidate / "shared.txt").unlink()
        self.controller.stage(["shared.txt"])
        self.assertEqual(
            self.git(self.candidate, "diff", "--cached", "--name-status"),
            "D\tshared.txt",
        )
        self.assert_stable_unchanged()

    def test_unsafe_stage_request_cannot_partially_stage_safe_paths(self):
        self.write(self.candidate, "repair.txt", "change\n")
        (self.candidate / "escape").symlink_to(self.directory, target_is_directory=True)
        for unsafe in ("../original checkout/shared.txt", "escape/secret", ":(top)*"):
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                self.controller.stage(["repair.txt", unsafe])
            self.assertFalse(
                self.git(self.candidate, "diff", "--cached", "--name-only")
            )
        self.assert_stable_unchanged()

    def test_stage_refuses_unchanged_files(self):
        with self.assertRaises(ValueError):
            self.controller.stage(["shared.txt"])
        self.assertFalse(self.git(self.candidate, "diff", "--cached", "--name-only"))

    def test_authority_guard_rejects_unstaged_staged_and_committed_edits(self):
        self.write(self.candidate, ".fork/verify.py", "# changed acceptance fixture\n")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()
        self.git(self.candidate, "add", "--", ".fork/verify.py")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()
        self.git(self.candidate, "commit", "-m", "Changed verification fixture")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()
        self.assert_stable_unchanged()

    def test_authority_guard_catches_untracked_workflows(self):
        self.write(self.candidate, ".github/workflows/accept.yml", "name: synthetic\n")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_allows_ordinary_authored_changes(self):
        self.write(self.candidate, "src/feature.py", "answer = 42\n")
        self.controller.guard_authority()

    def merge_upstream_document(
        self, name=".claude/rules/example.md", content="Pinned upstream documentation\n"
    ):
        self.git(self.root, "switch", "fixture-upstream")
        self.write(self.root, name, content)
        self.git(self.root, "add", "--", name)
        self.git(self.root, "commit", "-m", "Upstream documentation")
        self.upstream = self.git(self.root, "rev-parse", "HEAD")
        self.git(self.root, "switch", "saturn/main")
        self.controller.state["upstream"] = self.upstream
        result = subprocess.run(
            [
                "git",
                "-C",
                str(self.candidate),
                "merge",
                "--no-ff",
                "--no-commit",
                self.upstream,
            ],
            capture_output=True,
            check=False,
        )
        self.assertIn(result.returncode, (0, 1), result.stderr)
        self.assertEqual(
            self.git(self.candidate, "rev-parse", "MERGE_HEAD"), self.upstream
        )
        return name

    def test_authority_guard_accepts_next_update_to_existing_upstream_skill(self):
        name = self.merge_upstream_document(".claude/skills/example/SKILL.md")
        self.git(self.candidate, "commit", "-m", "First documentation update")
        self.git(
            self.root,
            "merge",
            "--ff-only",
            self.git(self.candidate, "rev-parse", "HEAD"),
        )
        self.controller.state["base"] = self.git(self.root, "rev-parse", "HEAD")
        self.merge_upstream_document(name, "Next upstream revision\n")
        self.controller.guard_authority()

    def test_authority_guard_rejects_conflict_stages_with_pinned_worktree(self):
        name = self.merge_upstream_document()
        oid = self.git(self.candidate, "rev-parse", f"{self.upstream}:{name}")
        subprocess.run(
            ["git", "-C", str(self.candidate), "update-index", "--index-info"],
            input=f"0 {'0' * 40}\t{name}\n100644 {oid} 2\t{name}\n100644 {oid} 3\t{name}\n",
            text=True,
            capture_output=True,
            check=True,
        )
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_rejects_upstream_script_disguised_as_guidance(self):
        self.merge_upstream_document(".claude/skills/example/run.py")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_rejects_symlink_parent_with_pinned_bytes(self):
        self.merge_upstream_document()
        directory = self.candidate / ".claude/rules"
        target = self.candidate / "ordinary-rules"
        directory.rename(target)
        directory.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_accepts_exact_upstream_document_before_and_after_commit(
        self,
    ):
        name = self.merge_upstream_document()
        self.controller.guard_authority()
        self.git(self.candidate, "commit", "-m", "Merge upstream documentation")
        self.controller.guard_authority()
        self.write(self.candidate, name, "Pinned upstream documentation\n\n")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_rejects_staged_document_hidden_by_upstream_worktree(self):
        name = self.merge_upstream_document(
            ".claude/skills/example/references/guide.md"
        )
        self.controller.guard_authority()
        self.write(self.candidate, name, "Worker changes\n")
        self.git(self.candidate, "add", "--", name)
        self.write(self.candidate, name, "Pinned upstream documentation\n")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_rejects_committed_document_hidden_by_upstream_index(self):
        name = self.merge_upstream_document()
        self.controller.guard_authority()
        self.write(self.candidate, name, "Worker changes\n")
        self.git(self.candidate, "add", "--", name)
        self.git(self.candidate, "commit", "-m", "Divergent documentation")
        self.write(self.candidate, name, "Pinned upstream documentation\n")
        self.git(self.candidate, "add", "--", name)
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_rejects_fork_document_overwritten_with_upstream(self):
        name = ".claude/rules/example.md"
        self.write(self.root, name, "Fork-specific guidance\n")
        self.git(self.root, "add", "--", name)
        self.git(self.root, "commit", "-m", "Fork documentation")
        self.controller.state["base"] = self.git(self.root, "rev-parse", "HEAD")
        self.git(self.candidate, "merge", "--no-edit", self.controller.state["base"])
        self.merge_upstream_document(name)
        self.write(self.candidate, name, "Pinned upstream documentation\n")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()
        self.git(self.candidate, "add", "--", name)
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_rejects_document_mode_and_symlink_changes(self):
        name = self.merge_upstream_document()
        self.controller.guard_authority()
        path = self.candidate / name
        path.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()
        path.unlink()
        target = self.candidate / "ordinary.md"
        target.write_text("Pinned upstream documentation\n")
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_keeps_upstream_fork_policy_protected(self):
        self.merge_upstream_document(".claude/skills/fork-maintenance/SKILL.md")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_catches_control_renamed_outside_protected_directory(self):
        self.git(self.candidate, "mv", ".fork/verify.py", "ordinary.py")
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def test_authority_guard_keeps_relocated_knowledge_generator_protected(self):
        for name in (
            "docs/scripts/generate-agent-kb.ts",
            "docs/lib/markdown-corpus.ts",
        ):
            with self.subTest(name=name):
                self.write(self.candidate, name, "// Synthetic generator change\n")
                with self.assertRaisesRegex(ValueError, "Verification/control"):
                    self.controller.guard_authority()
                (self.candidate / name).unlink()

    def test_promotion_uses_exact_attestation_and_preserves_both_parent_histories(self):
        parents = self.git(
            self.candidate, "rev-list", "--parents", "-n", "1", self.head
        )
        with patch.object(
            sync_agent.verify_source, "require_verified", return_value={}
        ) as verify:
            self.controller.promote()
        verify.assert_called_once_with(
            "git@github.com:example/fork.git", self.head, branch=self.branch
        )
        self.assertEqual(self.git(self.root, "rev-parse", "HEAD"), self.head)
        self.assertEqual(
            self.git(self.root, "rev-list", "--parents", "-n", "1", "HEAD"), parents
        )
        self.assertEqual(
            self.git(self.root, "merge-base", self.base, "HEAD"), self.base
        )
        self.assertEqual(
            self.git(self.root, "merge-base", self.upstream, "HEAD"), self.upstream
        )
        self.assertEqual(self.git(self.root, "rev-parse", self.branch), self.head)
        self.assertEqual(self.controller.state["phase"], "complete")
        self.assertFalse(self.git(self.root, "for-each-ref", "refs/remotes/origin"))

    def test_promotion_rechecks_attestation_instead_of_trusting_saved_receipt(self):
        self.controller.save(receipt={"revision": self.head, "status": "success"})
        with patch.object(
            sync_agent.verify_source,
            "require_verified",
            side_effect=ValueError("unverified"),
        ):
            with self.assertRaisesRegex(ValueError, "unverified"):
                self.controller.promote()
        self.assert_stable_unchanged()

    def test_promotion_refuses_dirty_candidate_even_after_verification(self):
        self.write(self.candidate, "shared.txt", "unverified edit\n")
        with patch.object(
            sync_agent.verify_source, "require_verified", return_value={}
        ) as verify:
            with self.assertRaisesRegex(ValueError, "changed after verification"):
                self.controller.promote()
        verify.assert_not_called()
        self.assert_stable_unchanged()

    def test_promotion_preserves_original_working_changes(self):
        self.write(self.root, "shared.txt", "unrelated local work\n")
        with patch.object(
            sync_agent.verify_source, "require_verified", return_value={}
        ):
            with self.assertRaisesRegex(ValueError, "Original checkout changed"):
                self.controller.promote()
        self.assertEqual(
            (self.root / "shared.txt").read_text(), "unrelated local work\n"
        )
        self.assertEqual(self.git(self.root, "rev-parse", "HEAD"), self.base)

    def test_promotion_refuses_original_branch_advancing_during_the_run(self):
        self.write(self.root, "parallel.txt", "other developer work\n")
        self.git(self.root, "add", "--", "parallel.txt")
        self.git(self.root, "commit", "-m", "Independent feature fixture")
        newer = self.git(self.root, "rev-parse", "HEAD")
        with patch.object(
            sync_agent.verify_source, "require_verified", return_value={}
        ):
            with self.assertRaisesRegex(ValueError, "Original checkout changed"):
                self.controller.promote()
        self.assertEqual(self.git(self.root, "rev-parse", "HEAD"), newer)
        self.assertEqual(
            (self.root / "parallel.txt").read_text(), "other developer work\n"
        )

    def test_promotion_resumes_after_completed_fast_forward(self):
        self.git(self.root, "merge", "--ff-only", self.head)
        self.controller.save(phase="promoting")
        with patch.object(
            sync_agent.verify_source, "require_verified", return_value={}
        ) as verify:
            self.controller.promote()
        verify.assert_called_once()
        self.assertEqual(self.git(self.root, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.controller.state["phase"], "complete")

    def test_external_candidate_commit_is_rejected(self):
        unexpected = self.commit_candidate()
        with self.assertRaisesRegex(ValueError, "outside the controller"):
            self.controller.assert_candidate()
        self.assertEqual(self.controller.state["head"], self.head)
        self.assertEqual(self.git(self.candidate, "rev-parse", "HEAD"), unexpected)
        self.assert_stable_unchanged()

    def test_external_origin_change_is_rejected(self):
        self.git(
            self.root,
            "remote",
            "set-url",
            "origin",
            "git@github.com:example/another.git",
        )
        with self.assertRaisesRegex(ValueError, "destination changed"):
            self.controller.assert_candidate()
        self.assert_stable_unchanged()

    def test_interrupted_commit_is_recovered_only_for_recorded_tree_and_parent(self):
        self.write(self.candidate, "repair.txt", "reviewed repair\n")
        self.git(self.candidate, "add", "--", "repair.txt")
        tree = self.git(self.candidate, "write-tree")
        self.controller.save(commit_tree=tree)
        self.git(self.candidate, "commit", "-m", "Controller checkpoint fixture")
        committed = self.git(self.candidate, "rev-parse", "HEAD")
        self.controller.assert_candidate()
        self.assertEqual(self.controller.state["head"], committed)
        self.assertIsNone(self.controller.state["commit_tree"])
        self.assertEqual(
            json.loads(self.controller.state_path.read_text())["head"], committed
        )
        self.assert_stable_unchanged()

    def test_interrupted_commit_recovery_rejects_a_different_tree(self):
        self.controller.save(
            commit_tree=self.git(self.candidate, "rev-parse", "HEAD^{tree}")
        )
        self.commit_candidate()
        with self.assertRaisesRegex(ValueError, "outside the controller"):
            self.controller.assert_candidate()
        self.assert_stable_unchanged()

    def test_interrupted_commit_recovery_rejects_a_different_parent(self):
        self.controller.save(
            commit_tree=self.git(self.candidate, "rev-parse", "HEAD^{tree}")
        )
        self.git(self.candidate, "commit", "--amend", "-m", "External amended fixture")
        with self.assertRaisesRegex(ValueError, "outside the controller"):
            self.controller.assert_candidate()
        self.assert_stable_unchanged()

    def prepare_conflicted_candidate(self):
        self.git(self.root, "switch", "fixture-upstream")
        self.write(self.root, "shared.txt", "upstream requirement\n")
        self.git(self.root, "add", "--", "shared.txt")
        self.git(self.root, "commit", "-m", "Upstream shared requirement")
        self.upstream = self.git(self.root, "rev-parse", "HEAD")
        self.git(self.root, "switch", "saturn/main")
        self.write(self.root, "shared.txt", "fork requirement\n")
        self.git(self.root, "add", "--", "shared.txt")
        self.git(self.root, "commit", "-m", "Fork shared requirement")
        self.base = self.git(self.root, "rev-parse", "HEAD")
        self.controller.save(base=self.base, upstream=self.upstream)
        self.rewind_to_preparing(create_worktree=True)
        self.controller.resume_preparing()
        self.assertTrue(self.git(self.candidate, "ls-files", "--unmerged"))

    def prepare_real_preflight_candidate(self):
        self.prepare_conflicted_candidate()
        inputs = {
            "shared.txt": "fork requirement\nupstream requirement\n",
            "package.json": json.dumps({"packageManager": "pnpm@10.33.4"}),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            "AGENTS.md": "Read .fork/agent-policy.md before work.\n",
            ".fork/agent-policy.md": "Use .fork/plans and .fork/lessons.\n",
            ".fork/generated-artifacts.json": json.dumps(
                {
                    "version": 1,
                    "artifacts": [],
                    "forbidden_tracked": [".fork/local/**"],
                    "allowed_ignored": [],
                }
            ),
        }
        for name, content in inputs.items():
            self.write(self.candidate, name, content)
        self.git(self.candidate, "add", "--", *inputs)
        actual_run = self.controller.run

        def run(command, **kwargs):
            # This fixture has no application generators. Preflight runs the real
            # trusted verify.py subprocess against its real Git index and history.
            if kwargs.get("label") == "generated":
                return 0, self.directory / "unused-generation-log"
            return actual_run(command, **kwargs)

        return run

    def test_pending_merge_passes_index_gate_but_requires_committed_upstream(self):
        run = self.prepare_real_preflight_candidate()
        self.assertEqual(
            self.git(self.candidate, "rev-parse", "MERGE_HEAD"), self.upstream
        )
        with patch.object(self.controller, "run", side_effect=run) as commands:
            self.assertTrue(
                self.controller.gate("index"), self.controller.state["feedback"]
            )
            index_command = commands.call_args_list[0].args[0]
            self.assertNotIn("--upstream", index_command)
            self.assertEqual(
                index_command[index_command.index("--base") + 1], self.base
            )
            self.assertFalse(self.controller.gate("HEAD"))
            self.assertIn("merge-base", self.controller.state["feedback"])
            head_command = commands.call_args_list[-1].args[0]
            self.assertEqual(
                head_command[head_command.index("--upstream") + 1], self.upstream
            )
            self.git(self.candidate, "commit", "-m", "Resolved merge fixture")
            self.assertTrue(
                self.controller.gate("HEAD"), self.controller.state["feedback"]
            )
        self.assert_stable_unchanged()

    def test_pending_merge_index_gate_still_rejects_private_inputs(self):
        run = self.prepare_real_preflight_candidate()
        self.write(self.candidate, ".env", "EXAMPLE_VALUE=synthetic\n")
        self.git(self.candidate, "add", "--", ".env")
        with patch.object(self.controller, "run", side_effect=run):
            self.assertFalse(self.controller.gate("index"))
        self.assertIn(
            "tracked private environment input", self.controller.state["feedback"]
        )
        self.assert_stable_unchanged()

    def exercise_conflict_loop(self, *, fail_first_ci):
        self.prepare_conflicted_candidate()
        publications = []
        provider_calls = []
        gate_revisions = []
        actual_run = self.controller.run
        conflict_result = "fork requirement\nupstream requirement\n"

        def provider(*, review=False):
            provider_calls.append(review)
            if len(provider_calls) == 1:
                self.write(self.candidate, "shared.txt", conflict_result)
                return {
                    "action": "stage",
                    "paths": ["shared.txt"],
                    "summary": "Preserved both requirements",
                }
            if fail_first_ci and len(provider_calls) == 4:
                self.assertIn(
                    "Synthetic regression failure", self.controller.state["feedback"]
                )
                self.write(
                    self.candidate,
                    "regression.txt",
                    "CI repair verified by synthetic fixture\n",
                )
                return {
                    "action": "stage",
                    "paths": ["regression.txt"],
                    "summary": "Repaired regression",
                }
            return {
                "action": "ready",
                "paths": [],
                "summary": "Fixture review complete",
            }

        def generation_gate(revision):
            gate_revisions.append(revision)
            return True

        def publication():
            self.controller.assert_candidate()
            self.assertFalse(self.git(self.candidate, "status", "--porcelain"))
            publications.append(self.controller.state["head"])
            self.controller.save(phase="ci")

        def command(arguments, **kwargs):
            if arguments[:2] == ["gh", "run"]:
                diagnostic = self.controller.local / "synthetic-ci.log"
                diagnostic.write_text("Synthetic regression failure\n")
                return 0, diagnostic
            return actual_run(arguments, **kwargs)

        attestations = (
            [
                sync_agent.verify_source.VerificationFailed(
                    "Synthetic CI failure", run_id=12
                ),
                {"status": "success"},
                {"status": "success"},
            ]
            if fail_first_ci
            else [{"status": "success"}, {"status": "success"}]
        )
        with (
            patch.object(self.controller, "codex", side_effect=provider),
            patch.object(self.controller, "gate", side_effect=generation_gate),
            patch.object(self.controller, "publish", side_effect=publication),
            patch.object(self.controller, "run", side_effect=command),
            patch.object(
                sync_agent.verify_source, "require_verified", side_effect=attestations
            ) as verified,
        ):
            self.controller.execute()
        final = self.git(self.root, "rev-parse", "HEAD")
        self.assertEqual(final, publications[-1])
        self.assertEqual(self.controller.state["phase"], "complete")
        self.assertEqual((self.root / "shared.txt").read_text(), conflict_result)
        self.assertEqual(self.git(self.root, "merge-base", self.base, final), self.base)
        self.assertEqual(
            self.git(self.root, "merge-base", self.upstream, final), self.upstream
        )
        self.assertFalse(self.git(self.root, "status", "--porcelain"))
        merge_parents = self.git(
            self.root, "rev-list", "--parents", "-n", "1", publications[0]
        ).split()
        self.assertEqual(merge_parents[1:], [self.base, self.upstream])
        expected_rounds = 2 if fail_first_ci else 1
        self.assertEqual(len(publications), expected_rounds)
        self.assertEqual(provider_calls, [False, False, True] * expected_rounds)
        self.assertEqual(gate_revisions, ["index", "HEAD"] * expected_rounds)
        self.assertEqual(
            verified.call_args.args, ("git@github.com:example/fork.git", final)
        )
        self.assertEqual(verified.call_args.kwargs, {"branch": self.branch})
        if fail_first_ci:
            self.assertEqual(
                self.git(self.root, "rev-parse", final + "^"), publications[0]
            )
            self.assertTrue((self.root / "regression.txt").is_file())

    def test_execute_resolves_real_conflict_commits_and_promotes_verified_merge(self):
        self.exercise_conflict_loop(fail_first_ci=False)

    def test_execute_repairs_ci_failure_and_verifies_the_new_revision(self):
        self.exercise_conflict_loop(fail_first_ci=True)

    def test_authority_guard_catches_schema_artifact_helper_change(self):
        self.write(
            self.candidate, ".fork/schema-artifacts.ts", "export const fixture = 1;\n"
        )
        with self.assertRaisesRegex(ValueError, "Verification/control"):
            self.controller.guard_authority()

    def rewind_to_preparing(self, *, create_worktree):
        self.git(self.root, "worktree", "remove", str(self.candidate))
        self.git(self.root, "branch", "-D", self.branch)
        self.controller.save(phase="preparing", head=self.base)
        if create_worktree:
            self.git(
                self.root,
                "worktree",
                "add",
                "-b",
                self.branch,
                str(self.candidate),
                self.base,
            )

    def assert_prepared_merge(self):
        self.assertEqual(
            self.git(self.candidate, "branch", "--show-current"), self.branch
        )
        self.assertEqual(self.git(self.candidate, "rev-parse", "HEAD"), self.base)
        self.assertEqual(
            self.git(self.candidate, "rev-parse", "MERGE_HEAD"), self.upstream
        )
        self.assertEqual(
            (self.candidate / "upstream.txt").read_text(), "upstream feature\n"
        )
        self.assertEqual((self.candidate / "fork.txt").read_text(), "fork feature\n")
        self.assertEqual(self.controller.state["phase"], "repair")
        self.assert_stable_unchanged()

    def test_prepare_recovers_after_state_saved_before_worktree_creation(self):
        self.rewind_to_preparing(create_worktree=False)
        self.assertTrue(self.controller.prepare())
        self.assert_prepared_merge()

    def test_prepare_recovers_after_worktree_created_before_merge(self):
        self.rewind_to_preparing(create_worktree=True)
        self.assertTrue(self.controller.prepare())
        self.assert_prepared_merge()

    def test_lock_excludes_another_process_and_releases_after_exception(self):
        lock = self.controller.local / "lock"
        probe = (
            "import fcntl, sys\n"
            "with open(sys.argv[1], 'a+') as stream:\n"
            "    try:\n"
            "        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
            "    except BlockingIOError:\n"
            "        sys.exit(23)\n"
        )
        with self.assertRaisesRegex(RuntimeError, "fixture interruption"):
            with sync_agent.exclusive_lock(lock):
                result = subprocess.run(
                    [sync_agent.sys.executable, "-c", probe, str(lock)],
                    capture_output=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 23)
                raise RuntimeError("fixture interruption")
        with sync_agent.exclusive_lock(lock):
            pass


if __name__ == "__main__":
    unittest.main()
