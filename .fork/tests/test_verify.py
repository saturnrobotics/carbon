"""Exercise committed/index evidence, including corruption hidden by regeneration."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import shutil

SPEC = importlib.util.spec_from_file_location(
    "fork_verify", Path(__file__).parents[1] / "verify.py"
)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Fixture")
        self.write(
            "package.json",
            json.dumps(
                {
                    "packageManager": "pnpm@10.33.4",
                    "scripts": {"clean": "rimraf node_modules"},
                }
            ),
        )
        self.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
        self.write("AGENTS.md", "Read .fork/agent-policy.md before work.\n")
        self.write(".fork/agent-policy.md", "Use .fork/plans and .fork/lessons.\n")
        self.write(
            ".fork/generated-artifacts.json",
            json.dumps(
                {
                    "version": 1,
                    "artifacts": [],
                    "forbidden_tracked": [
                        "**/__pycache__/**",
                        "**/.cert/**",
                        ".fork/local/**",
                        "generated.json",
                    ],
                    "allowed_ignored": [],
                }
            ),
        )
        self.commit()

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.root), *args], stderr=subprocess.DEVNULL, text=True
        ).strip()

    def write(self, path, data):
        dest = self.root / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(data)

    def commit(self):
        self.git("add", "--all")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def test_valid_commit_passes(self):
        self.assertEqual(verify.preflight(self.root), [])

    def test_committed_corruption_cannot_be_hidden_by_rewriting_worktree(self):
        self.write(
            "contract.json", "[\n<<<<<<< branch\n{}\n=======\n{}\n>>>>>>> upstream\n]\n"
        )
        self.commit()
        self.write("contract.json", "[]\n")
        self.assertTrue(any("contract.json" in e for e in verify.preflight(self.root)))

    def test_invalid_committed_json_without_markers_fails(self):
        self.write("contract.json", "{broken")
        self.commit()
        self.assertTrue(any("JSON" in e for e in verify.preflight(self.root)))

    def test_staged_corruption_cannot_be_hidden_by_unstaged_repair(self):
        self.write("contract.json", "{broken")
        self.git("add", "contract.json")
        self.write("contract.json", "{}")
        self.assertTrue(any("JSON" in e for e in verify.preflight(self.root, "index")))

    def test_forbidden_tracked_file_fails_even_when_gitignored(self):
        self.write("generated.json", "{}")
        self.commit()
        self.write(".gitignore", "generated.json\n")
        self.commit()
        self.assertTrue(any("generated.json" in e for e in verify.preflight(self.root)))

    def test_runtime_file_in_new_location_is_rejected(self):
        self.write("packages/example/__pycache__/cache.pyc", "bytes")
        self.commit()
        self.assertTrue(any("cache.pyc" in e for e in verify.preflight(self.root)))

    def test_missing_lockfile_is_rejected(self):
        (self.root / "pnpm-lock.yaml").unlink()
        self.commit()
        self.assertTrue(any("pnpm-lock.yaml" in e for e in verify.preflight(self.root)))

    def test_generic_clean_must_preserve_lockfile(self):
        self.write(
            "package.json",
            json.dumps(
                {
                    "packageManager": "pnpm@10.33.4",
                    "scripts": {"clean": "rimraf pnpm-lock.yaml"},
                }
            ),
        )
        self.commit()
        self.assertTrue(any("clean" in e for e in verify.preflight(self.root)))

    def test_missing_agent_policy_link_is_rejected(self):
        self.write("AGENTS.md", "Upstream guidance only")
        self.commit()
        self.assertTrue(any("AGENTS.md" in e for e in verify.preflight(self.root)))

    def test_historical_migration_changes_are_rejected(self):
        path = "packages/database/supabase/migrations/20260101000001_original.sql"
        self.write(path, "select 1;\n")
        base = self.commit()
        self.write(path, "select 2;\n")
        self.commit()
        self.assertTrue(
            any(
                "historical migration" in e
                for e in verify.preflight(self.root, base=base)
            )
        )

    def test_duplicate_migration_versions_are_rejected(self):
        for name in ("a", "b"):
            self.write(
                f"packages/database/supabase/migrations/20260101000001_{name}.sql",
                "select 1;\n",
            )
        self.commit()
        self.assertTrue(
            any("duplicate migration" in e for e in verify.preflight(self.root))
        )

    def test_new_forward_migration_is_allowed(self):
        base = self.git("rev-parse", "HEAD")
        self.write(
            "packages/database/supabase/migrations/20260101000002_new.sql",
            "select 1;\n",
        )
        self.commit()
        self.assertEqual(verify.preflight(self.root, base=base), [])

    def generator_fixture(self):
        self.write("output.json", '{"ok":true}\n')
        registry = json.loads(
            (self.root / ".fork/generated-artifacts.json").read_text()
        )
        registry["artifacts"] = [
            {
                "id": "fixture",
                "kind": "generated-contract",
                "group": "source",
                "inputs": ["package.json"],
                "tracked": ["output.json"],
                "command": ["fixture-generator"],
                "compare": "json",
            }
        ]
        self.write(".fork/generated-artifacts.json", json.dumps(registry))
        self.commit()

    def test_generation_compares_original_commit_not_repaired_worktree(self):
        self.generator_fixture()
        self.write("output.json", '{"ok":false}')
        self.commit()
        self.write("output.json", '{"ok":true}')
        errors = verify.generated(
            self.root, run=lambda _: self.write("output.json", '{"ok":true}')
        )
        self.assertTrue(any("differs from HEAD" in e for e in errors))

    def test_generator_nondeterminism_is_rejected(self):
        self.generator_fixture()
        count = [0]

        def run(_):
            count[0] += 1
            self.write("output.json", json.dumps({"count": count[0]}))

        self.assertTrue(
            any("repeatable" in e for e in verify.generated(self.root, run=run))
        )

    def test_generator_cannot_modify_source_or_lockfile(self):
        self.generator_fixture()

        def run(_):
            self.write("pnpm-lock.yaml", "silently rewritten")

        self.assertTrue(
            any("undeclared" in e for e in verify.generated(self.root, run=run))
        )

    def test_semantically_identical_json_is_allowed(self):
        self.generator_fixture()
        self.assertEqual(
            verify.generated(
                self.root, run=lambda _: self.write("output.json", '{\n "ok": true\n}')
            ),
            [],
        )

    def test_failing_generator_is_never_a_pass(self):
        self.generator_fixture()

        def run(_):
            raise subprocess.CalledProcessError(7, "fixture-generator")

        with self.assertRaises(subprocess.CalledProcessError):
            verify.generated(self.root, run=run)

    def test_conflicts_in_authored_lessons_are_rejected(self):
        self.write(
            ".fork/lessons/example.md",
            "<<<<<<< fork\nlesson\n=======\nother\n>>>>>>> upstream\n",
        )
        self.commit()
        self.assertTrue(any("conflict" in e for e in verify.preflight(self.root)))

    def test_generator_group_typo_is_rejected(self):
        self.generator_fixture()
        with self.assertRaisesRegex(ValueError, "group"):
            verify.generated(self.root, groups=["soruce"], run=lambda _: None)

    def test_generator_requires_source_matching_selected_revision(self):
        self.generator_fixture()
        self.write(
            "package.json",
            json.dumps(
                {"packageManager": "pnpm@10.33.4", "scripts": {"different": "input"}}
            ),
        )
        with self.assertRaisesRegex(ValueError, "source"):
            verify.generated(self.root, run=lambda _: None)

    def test_private_key_embedded_in_source_is_rejected(self):
        header = "-----BEGIN " + "PRIVATE KEY-----"
        footer = "-----END " + "PRIVATE KEY-----"
        self.write(
            "source.ts",
            "const key = `" + header + "\nZmFrZXRlc3RrZXk=\n" + footer + "`;\n",
        )
        self.commit()
        self.assertTrue(any("private key" in e for e in verify.preflight(self.root)))

    def test_private_key_escaped_in_json_service_account_is_rejected(self):
        header = "-----BEGIN " + "PRIVATE KEY-----"
        footer = "-----END " + "PRIVATE KEY-----"
        key = header + "\nZmFrZXRlc3RrZXk=\n" + footer + "\n"
        self.write("fixture.json", json.dumps({"nested": [{"private_key": key}]}))
        self.commit()
        errors = verify.preflight(self.root)
        self.assertTrue(any("private key" in error for error in errors))
        self.assertNotIn("ZmFrZXRlc3RrZXk", "\n".join(errors))

    def test_private_key_with_json_unicode_newlines_is_rejected(self):
        header = "-----BEGIN " + "PRIVATE KEY-----"
        footer = "-----END " + "PRIVATE KEY-----"
        key = header + "\nZmFrZXRlc3RrZXk=\n" + footer + "\n"
        self.write(
            "fixture.json", json.dumps({"private_key": key}).replace("\\n", "\\u000a")
        )
        self.commit()
        self.assertTrue(
            any("private key" in error for error in verify.preflight(self.root))
        )

    def test_complete_private_key_in_escaped_source_literal_is_rejected(self):
        header = "-----BEGIN " + "PRIVATE KEY-----"
        footer = "-----END " + "PRIVATE KEY-----"
        key = header + "\r\nZmFrZXRlc3RrZXk=\r\n" + footer + "\r\n"
        self.write("fixture.ts", "export const key = " + json.dumps(key) + ";\n")
        self.commit()
        self.assertTrue(
            any("private key" in error for error in verify.preflight(self.root))
        )

    def test_private_key_name_and_incomplete_template_are_allowed(self):
        self.write(
            "fixture.json", json.dumps({"private_key": "Set outside tracked files"})
        )
        self.write("fixture.ts", 'const header = "-----BEGIN ' + 'PRIVATE KEY-----";\n')
        self.commit()
        self.assertEqual(verify.preflight(self.root), [])

    def test_fork_lesson_cannot_be_added_to_upstream_namespace(self):
        upstream = self.git("rev-parse", "HEAD")
        self.write(".ai/lessons.md", "Fork-only record")
        self.commit()
        self.assertTrue(
            any(
                "fork-owned" in e
                for e in verify.preflight(self.root, upstream=upstream)
            )
        )

    def test_merged_upstream_lesson_is_allowed(self):
        self.write(".ai/lessons.md", "Upstream record")
        upstream = self.commit()
        self.write(".fork/lessons/new.md", "Fork-only record")
        self.commit()
        self.assertEqual(verify.preflight(self.root, upstream=upstream), [])

    def test_actual_hook_rejects_corruption_before_husky_or_dependencies_exist(self):
        project = Path(__file__).resolve().parents[2]
        for path in (".husky/pre-commit", ".fork/hooks/pre-commit", ".fork/verify.py"):
            dest = self.root / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(project / path, dest)
        self.write("contract.json", "{broken")
        self.git("add", "--all")
        result = subprocess.run(
            ["sh", ".husky/pre-commit"], cwd=self.root, capture_output=True, text=True
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid JSON", result.stderr)

    def test_new_root_generator_requires_registry_entry(self):
        package = json.loads((self.root / "package.json").read_text())
        package["scripts"]["generate:example"] = "some-generator"
        self.write("package.json", json.dumps(package))
        self.commit()
        self.assertTrue(
            any("unregistered generator" in e for e in verify.preflight(self.root))
        )

    def test_new_registered_generator_is_allowed(self):
        package = json.loads((self.root / "package.json").read_text())
        package["scripts"]["generate:example"] = "some-generator"
        self.write("package.json", json.dumps(package))
        registry = json.loads(
            (self.root / ".fork/generated-artifacts.json").read_text()
        )
        registry["artifacts"] = [
            {
                "id": "example",
                "kind": "build-output",
                "root_scripts": ["generate:example"],
                "inputs": ["package.json"],
                "untracked": ["example.out"],
                "group": "source",
                "command": ["some-generator"],
            }
        ]
        self.write(".fork/generated-artifacts.json", json.dumps(registry))
        self.commit()
        self.assertEqual(verify.preflight(self.root), [])

    def test_registry_rejects_incomplete_or_ambiguous_generators(self):
        self.generator_fixture()
        valid = json.loads((self.root / verify.REGISTRY).read_text())
        for field in ("id", "inputs", "tracked", "group", "command"):
            with self.subTest(field=field):
                registry = json.loads(json.dumps(valid))
                del registry["artifacts"][0][field]
                self.write(verify.REGISTRY, json.dumps(registry))
                self.assertTrue(verify.preflight(self.root, "worktree"))
        for update in (
            {"compare": "nonsense"},
            {"command": "shell string"},
            {"tracked": ["../outside"]},
            {"group": "unverified-new-generator"},
        ):
            with self.subTest(update=update):
                registry = json.loads(json.dumps(valid))
                registry["artifacts"][0].update(update)
                self.write(verify.REGISTRY, json.dumps(registry))
                self.assertTrue(verify.preflight(self.root, "worktree"))
        valid["artifacts"].append(dict(valid["artifacts"][0]))
        self.write(verify.REGISTRY, json.dumps(valid))
        self.assertTrue(verify.preflight(self.root, "worktree"))

    def test_local_generated_output_must_also_be_repeatable(self):
        self.generator_fixture()
        registry = json.loads((self.root / verify.REGISTRY).read_text())
        registry["artifacts"][0]["untracked"] = ["local.json"]
        self.write(verify.REGISTRY, json.dumps(registry))
        self.write(".gitignore", "local.json\n")
        self.commit()
        count = [0]

        def run(_):
            count[0] += 1
            self.write("local.json", json.dumps({"count": count[0]}))

        self.assertTrue(
            any("repeatable" in e for e in verify.generated(self.root, run=run))
        )

    def test_other_generated_groups_must_match_source_snapshot(self):
        self.generator_fixture()
        registry = json.loads((self.root / verify.REGISTRY).read_text())
        registry["artifacts"].append(
            {
                "id": "schema",
                "kind": "generated-contract",
                "group": "schema",
                "inputs": ["package.json"],
                "tracked": ["types.ts"],
                "command": ["other-generator"],
            }
        )
        self.write(verify.REGISTRY, json.dumps(registry))
        self.write("types.ts", "export type Example = string;\n")
        self.commit()
        self.write("types.ts", "export type Example = number;\n")
        with self.assertRaisesRegex(ValueError, "source"):
            verify.generated(self.root, run=lambda _: None)

    def test_generic_generation_cannot_connect_to_existing_database(self):
        self.generator_fixture()
        for group in ("schema", "schema-manifest"):
            with self.subTest(group=group):
                registry = json.loads((self.root / verify.REGISTRY).read_text())
                registry["artifacts"][0]["group"] = group
                self.write(verify.REGISTRY, json.dumps(registry))
                self.commit()
                with self.assertRaisesRegex(ValueError, "disposable"):
                    verify.generated(
                        self.root,
                        groups=[group],
                        run=lambda _: self.fail("must not run"),
                    )

    def test_pipeline_repetition_catches_stale_later_generator_input(self):
        self.generator_fixture()
        registry = json.loads((self.root / verify.REGISTRY).read_text())
        registry["artifacts"].append(
            {
                "id": "later",
                "kind": "generated-contract",
                "group": "source",
                "inputs": ["package.json"],
                "tracked": ["later.json"],
                "command": ["later"],
                "compare": "json",
            }
        )
        self.write(verify.REGISTRY, json.dumps(registry))
        self.write("output.json", "2")
        self.write("later.json", "1")
        self.commit()
        self.write("later.json", "2")

        def run(command):
            if command == ["later"]:
                self.write("later.json", "1")
            else:
                self.write("output.json", (self.root / "later.json").read_text())

        self.assertTrue(
            any("repeatable" in e for e in verify.generated(self.root, run=run))
        )

    def test_upstream_authored_record_cannot_be_silently_deleted(self):
        self.write(".ai/lessons.md", "Upstream lesson")
        upstream = self.commit()
        (self.root / ".ai/lessons.md").unlink()
        self.commit()
        self.assertTrue(verify.preflight(self.root, upstream=upstream))

    def test_directory_cannot_replace_required_local_output(self):
        self.generator_fixture()
        registry = json.loads((self.root / verify.REGISTRY).read_text())
        registry["artifacts"][0]["untracked"] = ["local.json"]
        self.write(verify.REGISTRY, json.dumps(registry))
        self.commit()
        (self.root / "local.json").mkdir()
        self.assertTrue(verify.generated(self.root, run=lambda _: None))

    def test_ignored_environment_mutation_is_rejected(self):
        self.generator_fixture()
        self.write(".gitignore", ".env\n")
        self.commit()
        self.write(".env", "FIXTURE=before\n")
        self.assertTrue(
            verify.generated(
                self.root, run=lambda _: self.write(".env", "FIXTURE=after\n")
            )
        )

    def test_recursive_glob_includes_direct_children(self):
        self.assertTrue(verify.matches("docs/example.md", ["docs/**/*.md"]))
        self.assertTrue(verify.matches("docs/nested/example.md", ["docs/**/*.md"]))

    def test_mixed_markdown_and_json_outputs_compare_json_semantically(self):
        self.generator_fixture()
        registry = json.loads((self.root / verify.REGISTRY).read_text())
        registry["artifacts"][0].pop("compare")
        registry["artifacts"][0]["tracked"].append("article.md")
        self.write(verify.REGISTRY, json.dumps(registry))
        self.write("article.md", "# Article\n")
        self.commit()
        self.assertEqual(
            verify.generated(
                self.root, run=lambda _: self.write("output.json", '{\n "ok": true\n}')
            ),
            [],
        )

    def test_recursive_local_output_glob_reads_files(self):
        self.generator_fixture()
        registry = json.loads((self.root / verify.REGISTRY).read_text())
        registry["artifacts"][0]["untracked"] = ["local/**"]
        self.write(verify.REGISTRY, json.dumps(registry))
        self.write(".gitignore", "local/\n")
        self.commit()
        count = [0]

        def run(_):
            count[0] += 1
            self.write("local/nested/example.json", str(count[0]))

        self.assertTrue(
            any("repeatable" in e for e in verify.generated(self.root, run=run))
        )


if __name__ == "__main__":
    unittest.main()
