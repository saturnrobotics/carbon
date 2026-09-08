"""Exercise the agent entry points and the real harness installer in isolation."""

import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SKILL = pathlib.Path(".claude/skills/fork-maintenance/SKILL.md")
POLICY = pathlib.Path(".fork/agent-policy.md")


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="carbon-policy-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture = pathlib.Path(self.temporary.name)
        for relative in (
            pathlib.Path("AGENTS.md"),
            pathlib.Path("CLAUDE.md"),
            pathlib.Path(".ai/scripts/install-skills.sh"),
            SKILL,
            POLICY,
        ):
            destination = self.fixture / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)

    def install(self):
        return subprocess.run(
            ["bash", ".ai/scripts/install-skills.sh", "--skills-only"],
            cwd=self.fixture,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_both_harness_entry_points_load_fork_policy_before_task_router(self):
        claude = (self.fixture / "CLAUDE.md").read_text()
        self.assertIn("@AGENTS.md", claude)
        agents = (self.fixture / "AGENTS.md").read_text()
        self.assertLess(agents.index(str(POLICY)), agents.index("## Always"))
        self.assertIn(str(SKILL), agents)
        policy = (self.fixture / POLICY).read_text()
        for artifact in (".fork/plans/", ".fork/lessons/", ".fork/local/"):
            self.assertIn(artifact, policy)
        self.assertIn("override", policy)
        self.assertIn(".ai/", policy)

    def test_installer_registers_and_copies_the_new_skill_without_source_edits(self):
        before = (self.fixture / SKILL).read_bytes()
        installed = self.install()
        self.assertIn("Done.", installed.stdout)
        self.assertNotIn("⚠", installed.stderr)
        copied = self.fixture / ".codex/skills/fork-maintenance/SKILL.md"
        self.assertEqual(copied.read_bytes(), before)
        self.assertEqual((self.fixture / SKILL).read_bytes(), before)
        listing = subprocess.run(
            ["bash", ".ai/scripts/install-skills.sh", "--list"],
            cwd=self.fixture,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("  fork-maintenance", listing.stdout.splitlines())

    def test_reinstall_replaces_stale_harness_copy_and_preserves_authored_policy(self):
        before = (self.fixture / POLICY).read_bytes()
        self.install()
        copied = self.fixture / ".codex/skills/fork-maintenance/SKILL.md"
        copied.write_text("stale instructions referencing .ai/plans/\n")
        self.install()
        self.assertEqual(copied.read_bytes(), (self.fixture / SKILL).read_bytes())
        self.assertEqual((self.fixture / POLICY).read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
