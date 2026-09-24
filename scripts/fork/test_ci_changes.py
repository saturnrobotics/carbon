"""Regression tests for pre-install CI selection, including real Git histories."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from ci_changes import CHECKS, classify_paths, select_checks


class PathSelectionTests(unittest.TestCase):
    def selected(self, paths):
        return {key for key, value in classify_paths(paths).items() if value}

    def test_upstream_workflow_only_needs_workflow_validation(self):
        self.assertEqual(
            self.selected([".github/workflows/upstream-sync.yml"]), {"workflow"}
        )

    def test_known_fork_prose_needs_no_heavy_checks(self):
        self.assertEqual(
            self.selected([".fork/plans/example.md", "docs/fork/README.md"]), set()
        )

    def test_source_runs_node_consumers_and_localization(self):
        self.assertEqual(
            self.selected(["apps/erp/app/components/Example.tsx"]),
            {"node", "lingui", "catalog", "fork_node"},
        )

    def test_database_source_includes_edge_tests(self):
        self.assertIn("edge", self.selected(["packages/database/src/types.ts"]))

    def test_deployment_python_selects_deployment_tests(self):
        self.assertEqual(
            self.selected(["contrib/deploying/gcp-tailscale/test_release.py"]),
            {"fork_python"},
        )

    def test_multi_input_union_preserves_each_required_check(self):
        self.assertEqual(
            self.selected(
                [
                    ".github/workflows/upstream-sync.yml",
                    "contrib/deploying/test_tool.py",
                ]
            ),
            {"workflow", "fork_python"},
        )

    def test_shell_helpers_also_cover_generator_callers(self):
        self.assertEqual(self.selected(["scripts/fork/regenerate.sh"]), set(CHECKS))

    def test_unknown_or_shared_inputs_run_everything(self):
        for path in (
            "new-directory/new-tool.txt",
            "pnpm-lock.yaml",
            "apps/erp/package.json",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.selected([path]), set(CHECKS))

    def test_pipeline_changes_run_everything(self):
        for path in (
            ".github/workflows/check.yml",
            ".github/workflows/fork-checks.yml",
            ".github/actions/ci-setup/action.yml",
            "scripts/fork/ci_changes.py",
            "scripts/fork/test_ci_changes.py",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.selected([path]), set(CHECKS))

    def test_documentation_code_is_not_treated_as_prose(self):
        self.assertEqual(self.selected(["docs/fork/script.py"]), set(CHECKS))


class HistorySelectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.git("init", "-q")
        self.git("config", "user.name", "CI Test")
        self.git("config", "user.email", "ci@example.com")
        self.git("config", "commit.gpgsign", "false")
        self.write("docs/fork/example.md", "Initial prose\n")
        self.base = self.commit()
        self.event_path = self.root / "event.json"

    def git(self, *args):
        result = subprocess.run(
            ["git", *args], cwd=self.root, check=True, capture_output=True, text=True
        )
        return result.stdout.strip()

    def write(self, path, contents):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents, encoding="utf-8")

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "Synthetic test change")
        return self.git("rev-parse", "HEAD")

    def select(self, base=None, head=None, event="pull_request"):
        self.event_path.write_text(
            json.dumps(
                {
                    "pull_request": {
                        "base": {"sha": base or self.base},
                        "head": {"sha": head or self.git("rev-parse", "HEAD")},
                    }
                }
            ),
            encoding="utf-8",
        )
        return select_checks(event, self.event_path, self.root)

    def test_push_and_dispatch_always_run_everything_without_reading_event(self):
        for event in ("push", "workflow_dispatch", "schedule"):
            self.assertTrue(all(select_checks(event, "/missing-event").values()))

    def test_doc_only_pr_skips_heavy_jobs(self):
        self.write("docs/fork/example.md", "Updated prose\n")
        self.commit()
        self.assertFalse(any(self.select().values()))

    def test_renames_include_original_path_even_with_newline_in_name(self):
        self.write("packages/database/src/old\nname.ts", "export const value = 1;\n")
        self.base = self.commit()
        self.git("mv", "packages/database/src/old\nname.ts", "docs/fork/moved.md")
        self.commit()
        self.assertTrue(self.select()["edge"])

    def test_deleted_source_is_included(self):
        self.write("packages/database/src/removed.ts", "export const value = 1;\n")
        self.base = self.commit()
        self.git("rm", "packages/database/src/removed.ts")
        self.commit()
        self.assertTrue(self.select()["edge"])

    def test_merge_base_excludes_changes_only_on_base_branch(self):
        self.git("checkout", "-qb", "target")
        self.write("pnpm-lock.yaml", "synthetic lockfile\n")
        advanced_base = self.commit()
        self.git("checkout", "-qb", "feature", self.base)
        self.write("docs/fork/example.md", "Feature prose\n")
        self.commit()
        self.assertFalse(any(self.select(base=advanced_base).values()))

    def test_missing_history_runs_everything(self):
        self.assertTrue(all(self.select(base="a" * 40).values()))

    def test_invalid_event_runs_everything(self):
        self.event_path.write_text("{broken", encoding="utf-8")
        self.assertTrue(
            all(select_checks("pull_request", self.event_path, self.root).values())
        )

    def test_cli_writes_boolean_outputs_for_every_contract_key(self):
        self.write(".github/workflows/upstream-sync.yml", "name: synthetic\n")
        self.commit()
        self.select()
        output = self.root / "outputs"
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("ci_changes.py"))],
            cwd=self.root,
            env={
                **os.environ,
                "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_EVENT_PATH": str(self.event_path),
                "GITHUB_OUTPUT": str(output),
            },
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(output.exists(), "CLI must create GITHUB_OUTPUT")
        actual = dict(line.split("=", 1) for line in output.read_text().splitlines())
        self.assertEqual(
            actual, {key: "true" if key == "workflow" else "false" for key in CHECKS}
        )


if __name__ == "__main__":
    unittest.main()
