"""Exercise release selection against real Git trees and the pinned Turbo graph."""

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
spec = importlib.util.spec_from_file_location("release_plan", HERE / "release_plan.py")
release_plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_plan)


class RepositoryInputsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="carbon-input-test-")
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.write(
            "package.json",
            {
                "name": "fixture",
                "private": True,
                "packageManager": "pnpm@10.33.4",
                "scripts": {
                    "build:erp": "turbo run build --filter=erp",
                    "build:mes": "turbo run build --filter=mes",
                    "lint": "echo lint",
                },
            },
        )
        self.write(
            "turbo.json",
            {"tasks": {"build": {"dependsOn": ["^build"]}, "test": {"cache": False}}},
        )
        self.write(
            "pnpm-workspace.yaml",
            "packages:\n  - apps/*\n  - packages/*\ncatalog:\n  unused: '1.0.0'\n",
        )
        self.write(
            "pnpm-lock.yaml",
            "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n  apps/erp:\n    dependencies:\n      '@fixture/shared':\n        specifier: workspace:*\n        version: link:../../packages/shared\n  apps/mes: {}\n  packages/shared: {}\n",
        )
        self.write(".npmrc", "engine-strict=true\n")
        self.write("Dockerfile", "FROM scratch\n")
        self.write(
            "packages/shared/package.json",
            {"name": "@fixture/shared", "exports": "./index.ts"},
        )
        self.write("packages/shared/index.ts", "export const value = 1;\n")
        for app in ("erp", "mes"):
            package = {"name": app, "scripts": {"build": "echo build"}}
            if app == "erp":
                package["dependencies"] = {"@fixture/shared": "workspace:*"}
            self.write(f"apps/{app}/package.json", package)
            self.write(f"apps/{app}/index.ts", "export const app = 1;\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "-qm",
            "initial",
        )
        (self.repo / "node_modules").symlink_to(
            REPO / "node_modules", target_is_directory=True
        )
        self.desired = {
            "schema_version": 1,
            "generation": 1,
            "services": {
                app: {
                    "workspace": app,
                    "inputs": {"base_image_digest": "sha256:fixture"},
                    "runtime_config": {},
                    "secret_versions": {},
                    "source_commit": self.git("rev-parse", "HEAD"),
                    "source_code_url": "https://example.com/source",
                }
                for app in ("erp", "mes")
            },
        }
        self.before = self.materialize()
        self.previous = release_plan.plan(self.before, {})
        for service in self.previous["services"].values():
            service["image_digest"] = "sha256:" + "d" * 64

    def write(self, name, value):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value, dict) else value)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def materialize(self):
        return release_plan.materialize_repository_inputs(
            copy.deepcopy(self.desired), self.repo
        )

    def selected(self):
        return set(release_plan.plan(self.materialize(), self.previous)["build"])

    def test_unused_catalog_and_unrelated_root_command_do_not_build_apps(self):
        self.write(
            "pnpm-workspace.yaml",
            "packages:\n  - apps/*\n  - packages/*\ncatalog:\n  unused: '2.0.0'\n",
        )
        manifest = json.loads((self.repo / "package.json").read_text())
        manifest["scripts"]["lint"] = "echo different lint"
        self.write("package.json", manifest)
        self.assertEqual(self.selected(), set())

    def test_unrelated_turbo_task_does_not_build_apps(self):
        self.write(
            "turbo.json",
            {
                "tasks": {
                    "build": {"dependsOn": ["^build"]},
                    "test": {"cache": True, "env": ["TEST_ONLY"]},
                }
            },
        )
        self.assertEqual(self.selected(), set())

    def test_effective_turbo_build_change_selects_both_consumers(self):
        self.write(
            "turbo.json",
            {"tasks": {"build": {"dependsOn": ["^build"], "env": ["BUILD_MODE"]}}},
        )
        self.assertEqual(self.selected(), {"erp", "mes"})

    def test_shared_package_without_build_script_still_selects_its_consumer(self):
        self.write("packages/shared/index.ts", "export const value = 2;\n")
        self.assertEqual(self.selected(), {"erp"})

    def test_build_reasons_identify_changed_component_and_path(self):
        self.write("apps/erp/index.ts", "export const app = 2;\n")
        planned = release_plan.plan(self.materialize(), self.previous)
        self.assertEqual(set(planned["build"]), {"erp"})
        self.assertTrue(
            any(
                "source" in reason and "index.ts" in reason
                for reason in planned["build"]["erp"]
            ),
            planned["build"],
        )

    def test_restricted_build_task_does_not_hide_bundled_package_source(self):
        self.write(
            "packages/shared/package.json",
            {
                "name": "@fixture/shared",
                "exports": "./index.ts",
                "scripts": {"build": "echo fonts"},
            },
        )
        self.write(
            "turbo.json",
            {
                "tasks": {
                    "build": {"dependsOn": ["^build"]},
                    "@fixture/shared#build": {"inputs": ["package.json"]},
                }
            },
        )
        self.previous = release_plan.plan(self.materialize(), {})
        for service in self.previous["services"].values():
            service["image_digest"] = "sha256:" + "d" * 64
        self.write("packages/shared/index.ts", "export const value = 3;\n")
        self.assertEqual(self.selected(), {"erp"})

    def test_active_root_generator_helper_change_selects_only_its_consumer(self):
        manifest = json.loads((self.repo / "package.json").read_text())
        manifest["scripts"]["generate:fixture"] = "node scripts/main.mjs"
        self.write("package.json", manifest)
        self.write("scripts/main.mjs", "import './helper.mjs';\n")
        self.write("scripts/helper.mjs", "export const generated = 1;\n")
        self.write(
            "turbo.json",
            {
                "tasks": {
                    "build": {"dependsOn": ["^build"]},
                    "erp#build": {"dependsOn": ["^build", "//#generate:fixture"]},
                    "//#generate:fixture": {"inputs": ["scripts/main.mjs"]},
                }
            },
        )
        self.git("add", "scripts", "package.json", "turbo.json")
        self.previous = release_plan.plan(self.materialize(), {})
        for service in self.previous["services"].values():
            service["image_digest"] = "sha256:" + "d" * 64
        self.write("scripts/helper.mjs", "export const generated = 2;\n")
        self.assertEqual(self.selected(), {"erp"})

    def test_root_build_command_change_selects_only_its_app(self):
        manifest = json.loads((self.repo / "package.json").read_text())
        manifest["scripts"]["build:erp"] += " --env-mode=loose"
        self.write("package.json", manifest)
        self.assertEqual(self.selected(), {"erp"})

    def test_ownership_diff_covers_upstream_merge_and_deleted_paths(self):
        base = self.git("rev-parse", "HEAD")
        self.git("checkout", "-qb", "upstream-fixture")
        self.write("apps/erp/upstream.ts", "export const upstream = true;\n")
        self.git("add", "apps/erp/upstream.ts")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "-qm",
            "upstream",
        )
        self.git("checkout", "-qb", "fork-fixture", base)
        (self.repo / "apps/mes/index.ts").unlink()
        self.git("add", "apps/mes/index.ts")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "-qm",
            "fork deletion",
        )
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "merge",
            "--no-edit",
            "upstream-fixture",
        )
        desired = self.materialize()
        desired.update(
            release_plan.classify_repository_changes(
                self.repo,
                self.git("rev-parse", "HEAD"),
                {"prepared_source_commit": base},
            )
        )
        self.assertEqual(
            set(desired["changed_inputs"]),
            {"apps/erp/upstream.ts", "apps/mes/index.ts"},
        )
        self.assertEqual(
            set(release_plan.plan(desired, self.previous)["build"]), {"erp", "mes"}
        )

    def test_unknown_top_level_input_remains_a_blocker_in_real_git_diff(self):
        base = self.git("rev-parse", "HEAD")
        self.write("new-generator/input.ts", "export const value = true;\n")
        self.git("add", "new-generator/input.ts")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "-qm",
            "new input",
        )
        desired = self.materialize()
        desired.update(
            release_plan.classify_repository_changes(
                self.repo,
                self.git("rev-parse", "HEAD"),
                {"prepared_source_commit": base},
            )
        )
        with self.assertRaisesRegex(
            ValueError, "Unknown input ownership.*new-generator"
        ):
            release_plan.plan(desired, self.previous)


if __name__ == "__main__":
    unittest.main()
