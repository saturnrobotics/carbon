"""Failure injection for immutable migration and disposable-resource boundaries."""

import importlib.util
import json
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    "fork_schema", Path(__file__).parents[1] / "schema.py"
)
schema = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(schema)
PREFIX = schema.MIGRATIONS


class ProvenanceTests(unittest.TestCase):
    def test_dirty_generator_input_cannot_attest_committed_revision(self):
        with self.assertRaisesRegex(ValueError, "uncommitted"):
            schema.check_committed_inputs(
                {"generator.ts": b"old"}, {"generator.ts": b"new"}
            )

    def test_untracked_generator_input_cannot_attest_committed_revision(self):
        with self.assertRaisesRegex(ValueError, "uncommitted"):
            schema.check_committed_inputs({}, {"generator.ts": b"new"})

    def registry(self):
        return json.loads(
            (Path(__file__).parents[1] / "generated-artifacts.json").read_text()
        )

    def test_known_schema_registry_has_complete_coverage(self):
        schema.check_artifact_inventory(self.registry())

    def test_new_schema_registry_output_requires_comparison_support(self):
        registry = self.registry()
        next(item for item in registry["artifacts"] if item["id"] == "db-types")[
            "tracked"
        ].append("packages/database/src/new-generated.ts")
        with self.assertRaisesRegex(ValueError, "inventory"):
            schema.check_artifact_inventory(registry)

    def test_new_schema_generator_cannot_silently_skip(self):
        registry = self.registry()
        registry["artifacts"].append(
            {"id": "new-schema", "group": "schema", "tracked": []}
        )
        with self.assertRaisesRegex(ValueError, "inventory"):
            schema.check_artifact_inventory(registry)

    def test_removing_schema_registry_entry_is_rejected(self):
        registry = self.registry()
        registry["artifacts"] = [
            item for item in registry["artifacts"] if item["id"] != "swagger"
        ]
        with self.assertRaisesRegex(ValueError, "inventory"):
            schema.check_artifact_inventory(registry)

    def test_base_platform_change_cannot_pass_migration_only_upgrade(self):
        with self.assertRaisesRegex(ValueError, "platform upgrade"):
            schema.check_platform_inputs(
                {"compose": b"image:1"}, {"compose": b"image:2"}
            )

    def test_base_bootstrap_change_cannot_pass_migration_only_upgrade(self):
        with self.assertRaisesRegex(ValueError, "platform upgrade"):
            schema.check_platform_inputs(
                {"init": b"CREATE ROLE old"}, {"init": b"CREATE ROLE new"}
            )

    def test_duplicate_migration_identity_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            schema.migration_manifest(
                {
                    PREFIX + "20260908010101_a.sql": b"SELECT 1;",
                    PREFIX + "20260908010101_b.sql": b"SELECT 2;",
                }
            )

    def test_historical_sql_change_is_rejected(self):
        path = PREFIX + "20260908010101_a.sql"
        with self.assertRaisesRegex(ValueError, "changed|missing"):
            schema.check_history({path: b"SELECT 1;"}, {path: b"SELECT 2;"})

    def test_deleted_migration_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "changed|missing"):
            schema.check_history({PREFIX + "20260908010101_a.sql": b"SELECT 1;"}, {})

    def test_missing_applied_migration_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            schema.check_applied({"20260908010101": {}}, [])

    def test_extra_applied_migration_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "extra"):
            schema.check_applied({}, ["20260908010101"])

    def test_duplicate_applied_migration_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            schema.check_applied({"20260908010101": {}}, ["20260908010101"] * 2)

    def test_definition_changes_move_the_fingerprint(self):
        for kind in ["FUNCTION", "VIEW", "TRIGGER", "POLICY", "CONSTRAINT"]:
            self.assertNotEqual(
                schema.schema_fingerprint(f"CREATE {kind} example old;\n"),
                schema.schema_fingerprint(f"CREATE {kind} example new;\n"),
            )

    def test_pg_dump_session_tokens_do_not_move_the_fingerprint(self):
        self.assertEqual(
            schema.schema_fingerprint(
                "\\restrict first\nCREATE TABLE example();\n\\unrestrict first\n"
            ),
            schema.schema_fingerprint(
                "\\restrict second\nCREATE TABLE example();\n\\unrestrict second\n"
            ),
        )

    def test_transport_like_lines_inside_function_bodies_remain_semantics(self):
        template = "\\restrict session\nCREATE FUNCTION example() RETURNS text AS $$\n\\restrict {}\n$$ LANGUAGE sql;\n\\unrestrict session\n"
        self.assertNotEqual(
            schema.schema_fingerprint(template.format("old")),
            schema.schema_fingerprint(template.format("new")),
        )


class IsolationTests(unittest.TestCase):
    def test_early_tables_without_both_ready_services_do_not_finish_bootstrap(self):
        for services in [
            {"gotrue": True, "storage": False},
            {"gotrue": False, "storage": True},
        ]:
            self.assertFalse(schema.bootstrap_ready(True, services))
        self.assertTrue(schema.bootstrap_ready(True, {"gotrue": True, "storage": True}))

    def test_service_connections_are_forced_into_allocated_network(self):
        config = {
            "services": {
                name: {
                    "image": "example/service:1.0",
                    "environment": {
                        "DATABASE_URL": "postgresql://external.example.com/production",
                        "PG_META_DB_URL": "postgresql://external.example.com/production",
                    },
                }
                for name in schema.SERVICES
            }
        }
        actual = schema.sanitize_compose(
            config, "carbon-fork-schema-example", Path("/tmp/synthetic/init.sql")
        )
        for service, variable in [
            ("gotrue", "GOTRUE_DB_DATABASE_URL"),
            ("storage", "DATABASE_URL"),
            ("postgrest", "PGRST_DB_URI"),
            ("meta", "PG_META_DB_URL"),
        ]:
            self.assertIn(
                "@postgres:5432/postgres",
                actual["services"][service]["environment"].get(variable, ""),
            )

    def test_foreign_resources_cannot_be_cleaned_up(self):
        with self.assertRaisesRegex(ValueError, "ownership"):
            schema.assert_owned(
                "carbon-fork-schema-example",
                [{"Labels": {"com.docker.compose.project": "another"}}],
            )

    def test_missing_run_label_cannot_be_cleaned_up(self):
        with self.assertRaisesRegex(ValueError, "ownership"):
            schema.assert_owned(
                "carbon-fork-schema-example",
                [
                    {
                        "Labels": {
                            "com.docker.compose.project": "carbon-fork-schema-example"
                        }
                    }
                ],
            )

    def test_compose_excludes_shared_services_host_mounts_and_fixed_ports(self):
        config = {
            "services": {
                "postgres": {
                    "image": "supabase/postgres:15.14.1.112",
                    "ports": ["5432:5432"],
                    "volumes": ["existing:/var/lib/postgresql/data"],
                },
                "gotrue": {
                    "image": "supabase/gotrue:v2.189.0",
                    "volumes": ["/private/example:/cert"],
                },
                "storage": {"image": "supabase/storage-api:v1.58.4"},
                "postgrest": {"image": "postgrest/postgrest:v13.0.8"},
                "meta": {"image": "supabase/postgres-meta:v0.96.5"},
                "redis": {"image": "redis:7"},
            },
            "networks": {"default": {"external": True}},
            "volumes": {"existing": {"external": True}},
        }
        actual = schema.sanitize_compose(
            config, "carbon-fork-schema-example", Path("/tmp/synthetic/init.sql")
        )
        self.assertNotIn("redis", actual["services"])
        self.assertFalse(actual["networks"]["default"].get("external", False))
        self.assertNotIn("existing", actual["volumes"])
        self.assertNotIn("volumes", actual["services"]["gotrue"])
        for service in ["postgres", "postgrest", "meta"]:
            for port in actual["services"][service]["ports"]:
                self.assertEqual(port["host_ip"], "127.0.0.1")
                self.assertEqual(port["published"], "0")

    def test_unpinned_service_image_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "image"):
            schema.sanitize_compose(
                {"services": {"postgres": {"image": "supabase/postgres:latest"}}},
                "carbon-fork-schema-example",
                Path("/tmp/synthetic/init.sql"),
            )


if __name__ == "__main__":
    unittest.main()
