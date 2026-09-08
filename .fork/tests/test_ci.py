"""Fail-closed CI scope, revision identity, and required-result fixtures."""

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "fork_ci", Path(__file__).parents[1] / "ci.py"
)
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


class ScopeTests(unittest.TestCase):
    def test_swagger_helpers_and_proof_require_real_schema_verification(self):
        registry = json.loads(
            (Path(__file__).parents[1] / "generated-artifacts.json").read_text()
        )
        for path in (
            "scripts/lib/swagger-schema.ts",
            "scripts/lib/swagger-schema.test.ts",
            "scripts/lib/swagger-partner-alias.sql",
            ".fork/tests/schema-artifacts.test.ts",
        ):
            with self.subTest(path=path):
                self.assertTrue(all(ci.classify([path], registry=registry).values()))

    def test_authored_docs_keep_source_checks_without_database_or_runtime_jobs(self):
        scope = ci.classify([".fork/plans/example.md", "docs/content/guide.mdx"])
        self.assertEqual(
            scope,
            {
                "source": True,
                "schema": False,
                "application": False,
                "invoice": False,
                "knowledge": False,
            },
        )

    def test_dependency_or_gate_changes_require_every_suite(self):
        for path in (
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "package.json",
            ".fork/ci.py",
            ".fork/verify.py",
            ".fork/generated-artifacts.json",
            ".github/workflows/fork-check.yml",
        ):
            with self.subTest(path=path):
                self.assertTrue(all(ci.classify([path]).values()))

    def test_deleted_migration_and_generated_schema_require_schema_and_behavior(self):
        for path in (
            "packages/database/supabase/migrations/20260101000000_deleted.sql",
            "packages/database/src/types.ts",
            "packages/jobs/manifests/schema.json",
            ".fork/tests/test_schema.py",
        ):
            with self.subTest(path=path):
                self.assertTrue(all(ci.classify([path]).values()))

    def test_package_change_covers_downstream_critical_consumers(self):
        scope = ci.classify(["packages/utils/src/math.ts"])
        self.assertFalse(scope["schema"])
        self.assertTrue(
            scope["application"] and scope["invoice"] and scope["knowledge"]
        )

    def test_daily_audit_requires_all_suites_even_without_changes(self):
        self.assertTrue(all(ci.classify([], full=True).values()))

    def test_manual_docs_diff_cannot_hide_runtime_changes_before_selected_base(self):
        self.assertTrue(
            all(ci.event_scope(["docs/readme.md"], "workflow_dispatch").values())
        )

    def test_schema_infrastructure_and_registry_inputs_cannot_silently_skip(self):
        for path in (
            ".fork/schema-artifacts.ts",
            "packages/dev/docker/docker-compose.dev.yml",
            "packages/jobs/src/backups/catalog.ts",
            "packages/jobs/src/scripts/check-backups.ts",
        ):
            with self.subTest(path=path):
                self.assertTrue(all(ci.classify([path]).values()))
        registry = {
            "artifacts": [{"group": "schema-manifest", "inputs": ["new-generator/**"]}]
        }
        self.assertTrue(
            ci.classify(["new-generator/input.ts"], registry=registry)["schema"]
        )


class AggregateTests(unittest.TestCase):
    def needs(self, required):
        scope = {job: job in required for job in ci.SUITES}
        needs = {
            "prepare": {
                "result": "success",
                "outputs": {"scope": json.dumps(scope), "revision": "a" * 40},
            }
        }
        needs.update(
            {
                job: {"result": "success" if needed else "skipped"}
                for job, needed in scope.items()
            }
        )
        return needs

    def test_explicitly_unrequired_job_can_be_skipped(self):
        ci.check_results(self.needs({"source"}), "a" * 40)

    def test_required_suite_never_accepts_missing_or_non_success(self):
        for result in ("failure", "cancelled", "skipped", "pending", "", None):
            with self.subTest(result=result):
                needs = self.needs(set(ci.SUITES))
                if result is None:
                    del needs["schema"]
                else:
                    needs["schema"]["result"] = result
                with self.assertRaises(ValueError):
                    ci.check_results(needs, "a" * 40)

    def test_missing_scope_and_wrong_revision_fail(self):
        needs = self.needs({"source"})
        with self.assertRaises(ValueError):
            ci.check_results(needs, "b" * 40)
        del needs["prepare"]["outputs"]["scope"]
        with self.assertRaises(ValueError):
            ci.check_results(needs, "a" * 40)

    def test_scope_cannot_disable_the_always_required_source_suite(self):
        needs = self.needs(set())
        with self.assertRaises(ValueError):
            ci.check_results(needs, "a" * 40)

    def test_scope_values_must_be_booleans_with_every_known_suite(self):
        for scope in ({"source": True}, {job: "false" for job in ci.SUITES}):
            needs = self.needs({"source"})
            needs["prepare"]["outputs"]["scope"] = json.dumps(scope)
            with self.assertRaises(ValueError):
                ci.check_results(needs, "a" * 40)

    def test_real_aggregate_cli_rejects_missing_result_evidence(self):
        result = subprocess.run(
            [
                sys.executable,
                str(Path(ci.__file__)),
                "aggregate",
                "--revision",
                "a" * 40,
                "--needs-json",
                "{}",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL fork CI", result.stderr)
        self.assertNotIn("PASS", result.stdout)


class LintTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="carbon-lint-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / ".fork").mkdir()
        (self.root / ".fork/generated-artifacts.json").write_text('{"artifacts": []}')
        (self.root / ".fork/biome-check.json").write_text(
            '{"files": {"includes": ["**/*.ts"]}}'
        )
        (self.root / "scripts").mkdir()
        (self.root / "scripts/source.ts").write_text("export const example = 1;\n")

    def result(self, unchanged):
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {"summary": {"unchanged": unchanged, "changed": 0}, "diagnostics": []}
            ),
        )

    def test_zero_checked_files_is_failure_even_when_biome_exits_zero(self):
        with patch.object(
            ci, "changed", return_value=["scripts/source.ts"]
        ), patch.object(
            ci.subprocess, "run", return_value=self.result(0)
        ), self.assertRaisesRegex(ValueError, "ignored"):
            ci.lint(self.root, "a" * 40)

    def test_scripts_use_expanded_configuration_and_every_file_must_be_checked(self):
        with patch.object(
            ci, "changed", return_value=["scripts/source.ts"]
        ), patch.object(ci.subprocess, "run", return_value=self.result(1)) as run:
            ci.lint(self.root, "a" * 40)
        command = run.call_args.args[0]
        self.assertTrue(
            any(
                arg.startswith("--config-path=") and arg.endswith("/biome.json")
                for arg in command
            )
        )
        self.assertIn("--error-on-warnings", command)
        self.assertEqual(command[-2:], ["--", "scripts/source.ts"])


class MandatoryUnittestTests(unittest.TestCase):
    def test_a_skipped_or_empty_successful_suite_fails_the_gate(self):
        for suite in (
            unittest.TestSuite(),
            unittest.TestSuite(
                [
                    unittest.FunctionTestCase(
                        lambda: self.skipTest("fixture infrastructure unavailable")
                    )
                ]
            ),
        ):
            with patch.object(
                ci.unittest.defaultTestLoader, "discover", return_value=suite
            ), patch.object(ci.sys, "stderr", io.StringIO()), self.assertRaises(
                ValueError
            ):
                ci.run_unittests(Path("/unused"), "fixture")


class WorkflowWiringTests(unittest.TestCase):
    def test_schedule_dispatches_an_exact_ref_instead_of_attesting_another_sha(self):
        root = Path(ci.__file__).parents[1]
        attesting = (root / ".github/workflows/fork-check.yml").read_text()
        dispatcher = (root / ".github/workflows/fork-audit-schedule.yml").read_text()
        self.assertNotIn("  schedule:", attesting)
        self.assertIn("  schedule:", dispatcher)
        self.assertIn("actions/workflows/fork-check.yml/dispatches", dispatcher)
        self.assertIn("-f ref=saturn/main", dispatcher)
        self.assertIn("github.event.pull_request.head.sha || github.sha", attesting)


class RevisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="carbon-ci-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "test@example.com")
        self.base = self.commit("base")
        self.head = self.commit("candidate")

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.root), *args], text=True, stderr=subprocess.DEVNULL
        ).strip()

    def commit(self, text):
        (self.root / "file").write_text(text)
        self.git("add", "file")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def test_push_stable_uses_previous_commit_from_event(self):
        event = {"ref": "refs/heads/saturn/main", "before": self.base}
        self.assertEqual(ci.baseline(self.root, "push", event, self.head), self.base)

    def test_lint_excludes_untracked_artifacts_preserved_locally_after_removal(self):
        (self.root / ".fork").mkdir()
        (self.root / ".fork/generated-artifacts.json").write_text('{"artifacts": []}')
        (self.root / "runtime.json").write_text("{}")
        self.git("add", ".fork/generated-artifacts.json", "runtime.json")
        base = self.commit("tracked runtime")
        self.git("rm", "--cached", "runtime.json")
        (self.root / ".gitignore").write_text("runtime.json\n")
        self.git("add", ".gitignore")
        self.commit("untracked runtime")
        with patch.object(
            ci, "biome", side_effect=AssertionError("deleted path must not be linted")
        ):
            ci.lint(self.root, base)

    def test_pull_request_must_be_same_repo_and_test_actual_head(self):
        event = {
            "pull_request": {
                "head": {"sha": self.head, "repo": {"full_name": "example/carbon"}},
                "base": {"sha": self.base},
            }
        }
        self.assertEqual(
            ci.baseline(
                self.root, "pull_request", event, self.head, repository="example/carbon"
            ),
            self.base,
        )
        with self.assertRaises(ValueError):
            ci.baseline(
                self.root,
                "pull_request",
                event,
                self.head,
                repository="different/carbon",
            )
        event["pull_request"]["head"]["sha"] = self.base
        with self.assertRaises(ValueError):
            ci.baseline(
                self.root, "pull_request", event, self.head, repository="example/carbon"
            )

    def test_missing_zero_equal_and_nonancestor_bases_are_rejected(self):
        for base in (None, "0" * 40, self.head, "b" * 40):
            with self.subTest(base=base), self.assertRaises(ValueError):
                ci.baseline(
                    self.root,
                    "push",
                    {"ref": "refs/heads/saturn/main", "before": base},
                    self.head,
                )
        self.git("checkout", "-q", "--detach", self.base)
        other = self.commit("other branch")
        self.git("checkout", "-q", "--detach", self.head)
        with self.assertRaises(ValueError):
            ci.baseline(
                self.root, "workflow_dispatch", {"inputs": {"base": other}}, self.head
            )

    def test_schedule_uses_first_parent_and_dispatch_requires_explicit_base(self):
        self.assertEqual(ci.baseline(self.root, "schedule", {}, self.head), self.base)
        with self.assertRaises(ValueError):
            ci.baseline(self.root, "workflow_dispatch", {}, self.head)
        self.assertEqual(
            ci.baseline(
                self.root,
                "workflow_dispatch",
                {"inputs": {"base": self.base}},
                self.head,
            ),
            self.base,
        )

    def test_sync_branch_uses_current_stable_baseline_not_event_before(self):
        self.git("update-ref", "refs/remotes/origin/saturn/main", self.base)
        self.assertEqual(
            ci.baseline(
                self.root,
                "push",
                {"ref": "refs/heads/sync/example", "before": "0" * 40},
                self.head,
            ),
            self.base,
        )


if __name__ == "__main__":
    unittest.main()
