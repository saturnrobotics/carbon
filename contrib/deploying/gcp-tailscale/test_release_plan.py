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
                    "lockfile": "lock-v1", "catalog": "catalog-v1",
                    "generators": {"scripts/generate-mcp.ts": "generator-v1"},
                    "assets": {}, "build_config": "docker-v1", "base_image_digest": "sha256:base",
                },
                "runtime_config": {"PORT": "3000"},
                "secret_versions": {"postgres_password": erp_secret},
            },
            "mes": {
                "source_commit": "b" * 40,
                "source_code_url": "https://github.com/example/carbon/tree/" + "b" * 40,
                "inputs": {
                    "source": {"apps/mes": mes_source}, "workspaces": {"packages/react": "react-v1"},
                    "lockfile": "lock-v1", "catalog": "catalog-v1", "generators": {},
                    "assets": {}, "build_config": "docker-v1", "base_image_digest": "sha256:base",
                },
                "runtime_config": {"PORT": "3000"}, "secret_versions": {},
            },
        },
        "input_owners": {"apps/erp": ["erp"], "apps/mes": ["mes"], "packages/react": ["erp", "mes"], "docs": []},
    }


class ReleasePlannerTests(unittest.TestCase):
    def test_noop_emits_no_mutations_and_preserves_immutable_service_identity(self):
        first = release_plan.plan(desired(), {"generation": 7, "services": {}})
        current = {"generation": 8, "services": first["services"]}
        result = release_plan.plan(desired(), current)
        self.assertEqual(result["build"], {})
        self.assertEqual(result["configure"], {})
        self.assertEqual(result["migrate"], {})
        self.assertEqual(result["deploy"], {})
        self.assertEqual(set(result["unchanged"]), {"erp", "mes"})
        self.assertEqual(result["services"]["erp"]["image_digest"], current["services"]["erp"]["image_digest"])
        self.assertEqual(result["services"]["mes"]["config_mount_path"], current["services"]["mes"]["config_mount_path"])

    def test_changed_build_requires_a_verified_receipt_instead_of_a_fabricated_digest(self):
        first = release_plan.plan(desired(), {"generation": 7, "services": {}})
        self.assertIsNone(first["services"]["erp"]["image_digest"])
        candidate = desired(erp_source="erp-v2")
        candidate["services"]["erp"]["build_receipt"] = {
            "build_fingerprint": release_plan.build_fingerprint(candidate["services"]["erp"]),
            "image_digest": "sha256:" + "c" * 64,
        }
        result = release_plan.plan(candidate, {"generation": 8, "services": first["services"]})
        self.assertEqual(result["services"]["erp"]["image_digest"], "sha256:" + "c" * 64)

    def test_unchanged_service_keeps_its_last_deployed_source_identity(self):
        first = release_plan.plan(desired(), {"generation": 7, "services": {}})
        candidate = desired()
        candidate["services"]["mes"]["source_commit"] = "c" * 40
        candidate["services"]["mes"]["source_code_url"] = "https://github.com/example/carbon/tree/" + "c" * 40
        result = release_plan.plan(candidate, {"generation": 8, "services": first["services"]})
        self.assertEqual(result["services"]["mes"]["source_commit"], first["services"]["mes"]["source_commit"])
        self.assertEqual(result["services"]["mes"]["source_code_url"], first["services"]["mes"]["source_code_url"])

    def test_docs_only_change_does_not_select_an_unrelated_app(self):
        first = release_plan.plan(desired(), {"generation": 7, "services": {}})
        result = release_plan.plan({**desired(), "changed_inputs": ["docs/guide.md"]}, {"generation": 8, "services": first["services"]})
        self.assertEqual(result["build"], {})
        self.assertEqual(result["deploy"], {})

    def test_shared_workspace_change_selects_actual_consumers(self):
        first = release_plan.plan(desired(), {"generation": 7, "services": {}})
        changed = desired()
        changed["services"]["erp"]["inputs"]["workspaces"]["packages/react"] = "react-v2"
        changed["services"]["mes"]["inputs"]["workspaces"]["packages/react"] = "react-v2"
        result = release_plan.plan(changed, {"generation": 8, "services": first["services"]})
        self.assertEqual(set(result["build"]), {"erp", "mes"})
        self.assertEqual(set(result["deploy"]), {"erp", "mes"})

    def test_secret_only_reuses_existing_image_and_reconfigures_one_service(self):
        first = release_plan.plan(desired(), {"generation": 7, "services": {}})
        result = release_plan.plan(desired(erp_secret="secret-v2"), {"generation": 8, "services": first["services"]})
        self.assertEqual(result["build"], {})
        self.assertEqual(set(result["configure"]), {"erp"})
        self.assertEqual(set(result["deploy"]), {"erp"})
        self.assertEqual(result["services"]["erp"]["image_digest"], first["services"]["erp"]["image_digest"])

    def test_config_only_change_reuses_existing_image_and_changes_only_its_mount(self):
        first = release_plan.plan(desired(), {"generation": 7, "services": {}})
        changed = desired()
        changed["services"]["erp"]["runtime_config"]["FEATURE_FLAG"] = "enabled"
        result = release_plan.plan(changed, {"generation": 8, "services": first["services"]})
        self.assertEqual(result["build"], {})
        self.assertEqual(set(result["configure"]), {"erp"})
        self.assertEqual(result["services"]["erp"]["image_digest"], first["services"]["erp"]["image_digest"])
        self.assertNotEqual(result["services"]["erp"]["config_mount_path"], first["services"]["erp"]["config_mount_path"])

    def test_unknown_changed_input_fails_for_review_instead_of_being_ignored(self):
        with self.assertRaisesRegex(ValueError, "Unknown input ownership.*private/new-generator"):
            release_plan.plan({**desired(), "changed_inputs": ["private/new-generator"]}, {"generation": 7, "services": {}})

    def test_migration_and_rollback_are_explicit_service_scoped_release_units(self):
        first = release_plan.plan(desired(), {"generation": 7, "services": {}})
        next_desired = desired(erp_source="erp-v2")
        next_desired["services"]["erp"]["migration"] = {"version": "2026090701", "compatible_with": ["2026090601"]}
        result = release_plan.plan(next_desired, {"generation": 8, "services": first["services"]})
        self.assertEqual(set(result["migrate"]), {"erp"})
        rollback = release_plan.rollback_plan(first, result)
        self.assertEqual(set(rollback["deploy"]), {"erp"})
        self.assertEqual(rollback["services"]["erp"]["image_digest"], first["services"]["erp"]["image_digest"])

    def test_incompatible_schema_does_not_migrate_during_an_app_rollout(self):
        deployed = release_plan.plan(desired(), {"generation": 7, "services": {}})
        deployed["services"]["erp"]["migration"] = {"version": "old", "compatible_with": []}
        candidate = desired(erp_source="erp-v2")
        candidate["services"]["erp"]["migration"] = {"version": "new", "compatible_with": []}
        with self.assertRaisesRegex(ValueError, "not compatible"):
            release_plan.plan(candidate, {"generation": 8, "services": deployed["services"]})

    def test_dependency_edge_add_and_remove_change_the_build_closure(self):
        deployed = release_plan.plan(desired(), {"generation": 7, "services": {}})
        added = desired()
        added["services"]["erp"]["inputs"]["workspaces"]["packages/new-shared"] = "new-v1"
        self.assertEqual(
            set(release_plan.plan(added, {"generation": 8, "services": deployed["services"]})["build"]),
            {"erp"},
        )
        removed_base = release_plan.plan(added, {"generation": 8, "services": deployed["services"]})
        self.assertEqual(
            set(release_plan.plan(desired(), {"generation": 9, "services": removed_base["services"]})["build"]),
            {"erp"},
        )

    def test_deleted_file_and_skipped_commits_are_detected_from_final_content(self):
        initial = desired()
        initial["services"]["erp"]["inputs"]["source"] = {
            "apps/erp/a.ts": "v1",
            "apps/erp/deleted.ts": "v1",
        }
        deployed = release_plan.plan(initial, {"generation": 7, "services": {}})
        final = desired(erp_source="v3-after-skipped-v2")
        final["services"]["erp"]["inputs"]["source"] = {"apps/erp/a.ts": "v3"}
        result = release_plan.plan(final, {"generation": 8, "services": deployed["services"]})
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
            any(path.startswith("scripts/generate-mcp.ts") for path in erp["generators"]["//#generate:mcp"]["inputs"])
        )

    def test_materialization_uses_workspace_graph_instead_of_manual_owned_paths(self):
        release = copy.deepcopy(desired())
        service = release["services"]["erp"]
        service.pop("owned_paths", None)
        service["workspace"] = "knowledge"
        service["build_paths"] = ["contrib/deploying/knowledge/Dockerfile.web", "turbo.json"]
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

        self.assertEqual(materialized["input_owners"]["pnpm-lock.yaml"], ["knowledge-web"])
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
