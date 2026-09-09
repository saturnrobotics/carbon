"""Behavioral tests for the offline, per-service release planner."""

import importlib.util
import copy
from pathlib import Path
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
spec = importlib.util.spec_from_file_location("release_plan", HERE / "release_plan.py")
release_plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_plan)


def desired(*, erp_source="erp-v1", mes_source="mes-v1", erp_secret="secret-v1"):
    return {
        "schema_version": 1,
        "generation": 8,
        "services": {
            "erp": {
                "source_commit": "a" * 40,
                "source_code_url": "https://github.com/example/carbon/tree/" + "a" * 40,
                "inputs": {
                    "source": {"apps/erp": erp_source},
                    "workspaces": {"packages/react": "react-v1"},
                    "lockfile": "lock-v1",
                    "catalog": "catalog-v1",
                    "generators": {"scripts/generate-mcp.ts": "generator-v1"},
                    "assets": {},
                    "build_config": "docker-v1",
                    "base_image_digest": "sha256:base",
                },
                "runtime_config": {"PORT": "3000"},
                "secret_versions": {"postgres_password": erp_secret},
            },
            "mes": {
                "source_commit": "b" * 40,
                "source_code_url": "https://github.com/example/carbon/tree/" + "b" * 40,
                "inputs": {
                    "source": {"apps/mes": mes_source},
                    "workspaces": {"packages/react": "react-v1"},
                    "lockfile": "lock-v1",
                    "catalog": "catalog-v1",
                    "generators": {},
                    "assets": {},
                    "build_config": "docker-v1",
                    "base_image_digest": "sha256:base",
                },
                "runtime_config": {"PORT": "3000"},
                "secret_versions": {},
            },
        },
        "input_owners": {
            "apps/erp": ["erp"],
            "apps/mes": ["mes"],
            "packages/react": ["erp", "mes"],
            "docs": [],
        },
    }


def successful_release(candidate=None):
    """Synthetic successful host receipt, including actual immutable image IDs."""
    receipt = release_plan.plan(
        candidate or desired(), {"generation": 7, "services": {}}
    )
    for service in receipt["services"].values():
        service["image_digest"] = "sha256:" + "d" * 64
    return receipt


class ReleasePlannerTests(unittest.TestCase):
    def test_missing_or_malformed_prior_image_cannot_authorize_reuse(self):
        for image in (None, "", "sha256:short", "mutable:latest"):
            with self.subTest(image=image):
                previous = successful_release()
                previous["services"]["erp"]["image_digest"] = image
                result = release_plan.plan(desired(), previous)
                self.assertEqual(set(result["build"]), {"erp"})
                self.assertTrue(
                    any("image identity" in reason for reason in result["build"]["erp"])
                )
                self.assertIsNone(result["services"]["erp"]["image_digest"])

    def test_configuration_reasons_name_keys_without_exposing_values(self):
        previous = successful_release()
        candidate = desired(erp_secret="synthetic-new-secret")
        candidate["services"]["erp"]["runtime_config"]["FEATURE_FLAG"] = (
            "synthetic-private-value"
        )
        result = release_plan.plan(candidate, previous)
        reasons = "\n".join(result["configure"]["erp"])
        self.assertIn("FEATURE_FLAG", reasons)
        self.assertIn("postgres_password", reasons)
        self.assertNotIn("synthetic-new-secret", str(result))
        self.assertNotIn("synthetic-private-value", str(result))

    def test_receipt_records_versioned_build_fingerprint(self):
        candidate = desired()
        receipt = successful_release(candidate)["services"]["erp"]
        version = receipt.get("build_input_version")
        self.assertIsInstance(version, int)
        self.assertGreater(version, 0)
        expected = release_plan.digest(
            {
                "version": version,
                "inputs": {
                    key: candidate["services"]["erp"]["inputs"][key]
                    for key in release_plan.BUILD_INPUTS
                },
            }
        )
        self.assertEqual(receipt["fingerprints"]["build"], expected)

    def test_older_input_version_requires_a_build_even_with_matching_hash(self):
        for version in (None, 0):
            with self.subTest(version=version):
                previous = successful_release()
                previous["services"]["erp"]["build_input_version"] = version
                result = release_plan.plan(desired(), previous)
                self.assertEqual(set(result["build"]), {"erp"})
                self.assertTrue(
                    any("version" in reason for reason in result["build"]["erp"])
                )
                self.assertIsNone(result["services"]["erp"]["image_digest"])

    def test_repository_closure_detects_executable_mode_without_content_change(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            script = repo / "entrypoint.sh"
            script.write_text("#!/bin/sh\nexit 0\n")
            script.chmod(0o644)
            before = release_plan.repository_closure(repo, ["entrypoint.sh"])
            script.chmod(0o755)
            after = release_plan.repository_closure(repo, ["entrypoint.sh"])
            self.assertNotEqual(before, after)

    def test_repository_closure_records_symlink_target_without_following_content(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            for name in ("first.sh", "second.sh"):
                (repo / name).write_text("#!/bin/sh\nexit 0\n")
            link = repo / "entrypoint.sh"
            link.symlink_to("first.sh")
            before = release_plan.repository_closure(repo, ["entrypoint.sh"])
            self.assertEqual(set(before), {"entrypoint.sh"})
            (repo / "first.sh").write_text("changed target content")
            self.assertEqual(
                before, release_plan.repository_closure(repo, ["entrypoint.sh"])
            )
            link.unlink()
            link.symlink_to("second.sh")
            self.assertNotEqual(
                before, release_plan.repository_closure(repo, ["entrypoint.sh"])
            )

    def test_repository_closure_rejects_nested_symlink_escaping_the_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            repo = parent / "repo"
            (repo / "helpers").mkdir(parents=True)
            (parent / "external.txt").write_text("synthetic external input")
            (repo / "helpers/escape").symlink_to(parent / "external.txt")
            with self.assertRaisesRegex(ValueError, "outside|escape"):
                release_plan.repository_closure(repo, ["helpers"])

    def test_noop_emits_no_mutations_and_preserves_immutable_service_identity(self):
        first = successful_release()
        current = {"generation": 8, "services": first["services"]}
        result = release_plan.plan(desired(), current)
        self.assertEqual(result["build"], {})
        self.assertEqual(result["configure"], {})
        self.assertEqual(result["migrate"], {})
        self.assertEqual(result["deploy"], {})
        self.assertEqual(set(result["unchanged"]), {"erp", "mes"})
        self.assertEqual(
            result["services"]["erp"]["image_digest"],
            current["services"]["erp"]["image_digest"],
        )
        self.assertEqual(
            result["services"]["mes"]["config_mount_path"],
            current["services"]["mes"]["config_mount_path"],
        )

    def test_changed_build_requires_a_verified_receipt_instead_of_a_fabricated_digest(
        self,
    ):
        first = successful_release()
        first = release_plan.plan(desired(), {"generation": 7, "services": {}})
        self.assertIsNone(first["services"]["erp"]["image_digest"])
        candidate = desired(erp_source="erp-v2")
        candidate["services"]["erp"]["build_receipt"] = {
            "build_fingerprint": release_plan.build_fingerprint(
                candidate["services"]["erp"]
            ),
            "image_digest": "sha256:" + "c" * 64,
        }
        result = release_plan.plan(
            candidate, {"generation": 8, "services": first["services"]}
        )
        self.assertEqual(
            result["services"]["erp"]["image_digest"], "sha256:" + "c" * 64
        )

    def test_unchanged_service_keeps_its_last_deployed_source_identity(self):
        first = successful_release()
        candidate = desired()
        candidate["services"]["mes"]["source_commit"] = "c" * 40
        candidate["services"]["mes"]["source_code_url"] = (
            "https://github.com/example/carbon/tree/" + "c" * 40
        )
        result = release_plan.plan(
            candidate, {"generation": 8, "services": first["services"]}
        )
        self.assertEqual(
            result["services"]["mes"]["source_commit"],
            first["services"]["mes"]["source_commit"],
        )
        self.assertEqual(
            result["services"]["mes"]["source_code_url"],
            first["services"]["mes"]["source_code_url"],
        )

    def test_docs_only_change_does_not_select_an_unrelated_app(self):
        first = successful_release()
        result = release_plan.plan(
            {**desired(), "changed_inputs": ["docs/guide.md"]},
            {"generation": 8, "services": first["services"]},
        )
        self.assertEqual(result["build"], {})
        self.assertEqual(result["deploy"], {})

    def test_shared_workspace_change_selects_actual_consumers(self):
        first = successful_release()
        changed = desired()
        changed["services"]["erp"]["inputs"]["workspaces"]["packages/react"] = (
            "react-v2"
        )
        changed["services"]["mes"]["inputs"]["workspaces"]["packages/react"] = (
            "react-v2"
        )
        result = release_plan.plan(
            changed, {"generation": 8, "services": first["services"]}
        )
        self.assertEqual(set(result["build"]), {"erp", "mes"})
        self.assertEqual(set(result["deploy"]), {"erp", "mes"})

    def test_secret_only_reuses_existing_image_and_reconfigures_one_service(self):
        first = successful_release()
        result = release_plan.plan(
            desired(erp_secret="secret-v2"),
            {"generation": 8, "services": first["services"]},
        )
        self.assertEqual(result["build"], {})
        self.assertEqual(set(result["configure"]), {"erp"})
        self.assertEqual(set(result["deploy"]), {"erp"})
        self.assertEqual(
            result["services"]["erp"]["image_digest"],
            first["services"]["erp"]["image_digest"],
        )

    def test_config_only_change_reuses_existing_image_and_changes_only_its_mount(self):
        first = successful_release()
        changed = desired()
        changed["services"]["erp"]["runtime_config"]["FEATURE_FLAG"] = "enabled"
        result = release_plan.plan(
            changed, {"generation": 8, "services": first["services"]}
        )
        self.assertEqual(result["build"], {})
        self.assertEqual(set(result["configure"]), {"erp"})
        self.assertEqual(
            result["services"]["erp"]["image_digest"],
            first["services"]["erp"]["image_digest"],
        )
        self.assertNotEqual(
            result["services"]["erp"]["config_mount_path"],
            first["services"]["erp"]["config_mount_path"],
        )

    def test_unknown_changed_input_fails_for_review_instead_of_being_ignored(self):
        with self.assertRaisesRegex(
            ValueError, "Unknown input ownership.*private/new-generator"
        ):
            release_plan.plan(
                {**desired(), "changed_inputs": ["private/new-generator"]},
                {"generation": 7, "services": {}},
            )

    def test_migration_and_rollback_are_explicit_service_scoped_release_units(self):
        first = successful_release()
        next_desired = desired(erp_source="erp-v2")
        next_desired["services"]["erp"]["migration"] = {
            "version": "2026090701",
            "compatible_with": ["2026090601"],
        }
        result = release_plan.plan(
            next_desired, {"generation": 8, "services": first["services"]}
        )
        self.assertEqual(set(result["migrate"]), {"erp"})
        rollback = release_plan.rollback_plan(first, result)
        self.assertEqual(set(rollback["deploy"]), {"erp"})
        self.assertEqual(
            rollback["services"]["erp"]["image_digest"],
            first["services"]["erp"]["image_digest"],
        )

    def test_incompatible_schema_does_not_migrate_during_an_app_rollout(self):
        deployed = successful_release()
        deployed["services"]["erp"]["migration"] = {
            "version": "old",
            "compatible_with": [],
        }
        candidate = desired(erp_source="erp-v2")
        candidate["services"]["erp"]["migration"] = {
            "version": "new",
            "compatible_with": [],
        }
        with self.assertRaisesRegex(ValueError, "not compatible"):
            release_plan.plan(
                candidate, {"generation": 8, "services": deployed["services"]}
            )

    def test_dependency_edge_add_and_remove_change_the_build_closure(self):
        deployed = successful_release()
        added = desired()
        added["services"]["erp"]["inputs"]["workspaces"]["packages/new-shared"] = (
            "new-v1"
        )
        self.assertEqual(
            set(
                release_plan.plan(
                    added, {"generation": 8, "services": deployed["services"]}
                )["build"]
            ),
            {"erp"},
        )
        removed_base = successful_release(added)
        self.assertEqual(
            set(
                release_plan.plan(
                    desired(), {"generation": 9, "services": removed_base["services"]}
                )["build"]
            ),
            {"erp"},
        )

    def test_deleted_file_and_skipped_commits_are_detected_from_final_content(self):
        initial = desired()
        initial["services"]["erp"]["inputs"]["source"] = {
            "apps/erp/a.ts": "v1",
            "apps/erp/deleted.ts": "v1",
        }
        deployed = successful_release(initial)
        final = desired(erp_source="v3-after-skipped-v2")
        final["services"]["erp"]["inputs"]["source"] = {"apps/erp/a.ts": "v3"}
        result = release_plan.plan(
            final, {"generation": 8, "services": deployed["services"]}
        )
        self.assertEqual(set(result["build"]), {"erp"})

    def test_actual_turbo_closure_has_pruned_lock_and_per_app_generators(self):
        web = release_plan.turbo_workspace_closure(REPO, "knowledge")
        query = release_plan.turbo_workspace_closure(REPO, "knowledge-query")
        erp = release_plan.turbo_workspace_closure(REPO, "erp")

        self.assertIn("@carbon/knowledge", web["packages"])
        self.assertNotIn("@carbon/utils", web["packages"])
        self.assertIn("@carbon/utils", query["packages"])
        self.assertNotEqual(web["lockfile"], query["lockfile"])
        self.assertIn("//#lingui:compile", web["generators"])
        self.assertNotIn("//#generate:mcp", web["generators"])
        self.assertIn("//#generate:mcp", erp["generators"])
        self.assertTrue(
            any(
                path.startswith("scripts/generate-mcp.ts")
                for path in erp["generators"]["//#generate:mcp"]["inputs"]
            )
        )

    def test_materialization_uses_workspace_graph_instead_of_manual_owned_paths(self):
        release = copy.deepcopy(desired())
        service = release["services"]["erp"]
        service.pop("owned_paths", None)
        service["workspace"] = "knowledge"
        service["build_paths"] = [
            "contrib/deploying/knowledge/Dockerfile.web",
            "turbo.json",
        ]
        release["services"] = {"knowledge-web": service}
        materialized = release_plan.materialize_repository_inputs(release, REPO)
        inputs = materialized["services"]["knowledge-web"]["inputs"]
        self.assertIn("@carbon/knowledge#build", inputs["workspaces"])
        self.assertRegex(inputs["lockfile"], r"^sha256:[a-f0-9]{64}$")
        self.assertNotIn("@carbon/utils#build", inputs["workspaces"])

    def test_materialized_lockfile_change_is_owned_by_each_workspace_service(self):
        release = copy.deepcopy(desired())
        service = release["services"]["erp"]
        service["workspace"] = "knowledge"
        service["build_paths"] = ["contrib/deploying/knowledge/Dockerfile.web"]
        release["services"] = {"knowledge-web": service}
        release["changed_inputs"] = ["pnpm-lock.yaml"]

        materialized = release_plan.materialize_repository_inputs(release, REPO)

        self.assertEqual(
            materialized["input_owners"]["pnpm-lock.yaml"], ["knowledge-web"]
        )
        release_plan.plan(materialized, {"generation": 7, "services": {}})

    def test_materialization_preserves_reviewed_non_workspace_ownership(self):
        release = copy.deepcopy(desired())
        service = release["services"]["erp"]
        service["workspace"] = "knowledge"
        service["build_paths"] = ["contrib/deploying/knowledge/Dockerfile.web"]
        release["services"] = {"knowledge-web": service}
        release["input_owners"] = {"docs": []}
        release["changed_inputs"] = ["docs/guide.md"]

        materialized = release_plan.materialize_repository_inputs(release, REPO)

        self.assertEqual(materialized["input_owners"]["docs"], [])
        release_plan.plan(materialized, {"generation": 7, "services": {}})

    def test_unrelated_catalog_entries_do_not_change_the_pruned_lock_fingerprint(self):
        prefix = "lockfileVersion: '9.0'\n\ncatalogs:\n  default:\n"
        suffix = "importers:\n  apps/example:\n    dependencies: {}\n"
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.yaml"
            second = Path(directory) / "second.yaml"
            first.write_text(prefix + "    unrelated: 1.0.0\n\n" + suffix)
            second.write_text(prefix + "    unrelated: 2.0.0\n\n" + suffix)
            self.assertEqual(
                release_plan.pruned_lock_content(first),
                release_plan.pruned_lock_content(second),
            )


if __name__ == "__main__":
    unittest.main()
