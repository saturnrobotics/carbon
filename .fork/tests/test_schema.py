"""Failure injection for immutable migration and disposable-resource boundaries."""

import importlib.util
import copy
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "fork_schema", Path(__file__).parents[1] / "schema.py"
)
schema = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(schema)
PREFIX = schema.MIGRATIONS
COMPOSE = "packages/dev/docker/docker-compose.dev.yml"
INIT = "packages/dev/docker/init.sql"
TRANSITION = "disable-supautils-permission-hints"


def platform(command=None):
    return {
        COMPOSE: {
            "services": {
                "postgres": {
                    "image": "supabase/postgres:15.14.1.112",
                    "command": command
                    or ["postgres", "-c", "config_file=/example.conf"],
                },
                "other": {
                    "image": "example/service:1.0",
                    "environment": {"SAFE": "fixture"},
                },
            }
        },
        INIT: b"-- immutable bootstrap\n",
    }


class PlatformTransitionTests(unittest.TestCase):
    def test_equal_resolved_variables_cannot_hide_different_source_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            stack = schema.DisposableStack(folder, folder, folder / "base.yml")
            classify = getattr(stack, "classify_platform", None)
            self.assertTrue(
                callable(classify),
                "Source interpolation changes must be checked before recognizing a transition",
            )
            for hint in (False, True):
                resolved_base = platform()[COMPOSE]
                resolved_candidate = copy.deepcopy(resolved_base)
                template_base = copy.deepcopy(resolved_base)
                template_base["services"]["other"]["environment"]["SAFE"] = "${ERP_URL}"
                template_candidate = copy.deepcopy(template_base)
                template_candidate["services"]["other"]["environment"]["SAFE"] = (
                    "${MES_URL}"
                )
                if hint:
                    for config in (resolved_candidate, template_candidate):
                        config["services"]["postgres"]["command"] += [
                            "-c",
                            "supautils.hint_roles=",
                        ]
                stack.resolved_compose = Mock(
                    side_effect=[
                        resolved_base,
                        resolved_candidate,
                        template_base,
                        template_candidate,
                    ]
                )
                with self.subTest(hint=hint), self.assertRaisesRegex(
                    ValueError, "platform upgrade"
                ):
                    classify(
                        folder / "base.yml", folder / "candidate.yml", b"same", b"same"
                    )

    def test_exact_additive_hint_argument_requires_a_real_transition(self):
        base = platform()
        candidate = copy.deepcopy(base)
        candidate[COMPOSE]["services"]["postgres"]["command"] += [
            "-c",
            "supautils.hint_roles=",
        ]
        try:
            result = schema.check_platform_inputs(base, candidate)
        except ValueError:
            result = "rejected"
        self.assertEqual(result, TRANSITION)
        self.assertIsNone(schema.check_platform_inputs(candidate, candidate))

    def test_every_other_platform_change_remains_rejected(self):
        base = platform()
        candidate = copy.deepcopy(base)
        candidate[COMPOSE]["services"]["postgres"]["command"] += [
            "-c",
            "supautils.hint_roles=",
        ]
        variants = []
        for field, value in (
            ("image", "supabase/postgres:16.0"),
            ("entrypoint", ["another"]),
            ("volumes", ["another:/data"]),
            ("environment", {"EXTRA": "value"}),
        ):
            changed = copy.deepcopy(candidate)
            changed[COMPOSE]["services"]["postgres"][field] = value
            variants.append(changed)
        changed = copy.deepcopy(candidate)
        changed[COMPOSE]["services"]["other"]["environment"]["SAFE"] = "changed"
        variants.append(changed)
        changed = copy.deepcopy(candidate)
        changed[INIT] = b"-- changed bootstrap\n"
        variants.append(changed)
        for suffix in (
            ["supautils.hint_roles="],
            ["-c", "supautils.hint_roles=authenticated"],
            ["-c", "supautils.hint_roles=", "-c", "supautils.hint_roles="],
            ["-c", "supautils.hint_roles=", "-c", "shared_preload_libraries="],
        ):
            changed = copy.deepcopy(base)
            changed[COMPOSE]["services"]["postgres"]["command"] += suffix
            variants.append(changed)
        for changed in variants:
            with self.subTest(changed=changed), self.assertRaisesRegex(
                ValueError, "platform upgrade"
            ):
                schema.check_platform_inputs(base, changed)
        with self.assertRaisesRegex(ValueError, "platform upgrade"):
            schema.check_platform_inputs(candidate, base)

    def test_restart_must_preserve_every_continuity_field(self):
        check = getattr(schema, "check_transition_continuity", None)
        self.assertTrue(
            callable(check), "A same-volume transition must compare persisted state"
        )
        before = {
            "owner": "fixture",
            "data": "random",
            "system": "1234",
            "migrations": ["1"],
            "schema": "hash",
            "volumes": {"pgdata": "original"},
        }
        check(before, copy.deepcopy(before))
        for key in before:
            after = copy.deepcopy(before)
            after[key] = "changed"
            with self.subTest(key=key), self.assertRaisesRegex(
                ValueError, "continuity"
            ):
                check(before, after)

    def test_denial_requires_execute_privileges_sqlstate_and_normal_psql_failure(self):
        check = getattr(schema, "check_denied_execute", None)
        self.assertTrue(
            callable(check), "A connection failure must not count as permission denial"
        )
        result = SimpleNamespace(
            returncode=3,
            stdout='{"usage":true,"execute":false}\n',
            stderr="ERROR:  42501: permission denied for function fixture\n",
        )
        check(result)
        for override in (
            {"returncode": 0},
            {"returncode": 2},
            {"stderr": "server closed the connection unexpectedly"},
            {"stderr": "ERROR:  42883: function does not exist"},
            {"stdout": '{"usage":false,"execute":false}'},
            {"stdout": '{"usage":true,"execute":true}'},
            {"stdout": "null"},
            {"stdout": "[]"},
            {"stdout": "invalid"},
        ):
            with self.subTest(override=override), self.assertRaisesRegex(
                ValueError, "permission"
            ):
                check(SimpleNamespace(**{**vars(result), **override}))

    def test_upgrade_transitions_between_base_and_candidate_migrations(self):
        execute = getattr(schema, "verify_stack", None)
        self.assertTrue(
            callable(execute),
            "Upgrade must execute the platform transition between migration stages",
        )
        events = []
        stack = Mock()
        stack.start.side_effect = lambda: events.append("start")
        stack.apply.side_effect = lambda files, cli: events.append(files)
        stack.transition_platform.side_effect = lambda kind, source: events.append(
            "transition"
        ) or {"kind": kind}
        stack.verify_permission_errors.side_effect = lambda: events.append(
            "permissions"
        )
        stack.fingerprint.return_value = "schema"
        stack.artifacts.return_value = {"types": "same"}
        stack.close.side_effect = lambda: events.append("close")
        result, evidence = execute(
            stack,
            "upgrade",
            ["base", "candidate"],
            "cli",
            TRANSITION,
            "candidate.yml",
            True,
        )
        self.assertEqual(
            events, ["start", "base", "transition", "candidate", "permissions", "close"]
        )
        self.assertEqual(result, {"schema": "schema", "artifacts": {"types": "same"}})
        self.assertEqual(evidence, {"kind": TRANSITION})

    def test_failed_transition_never_applies_candidate_or_generates_artifacts(self):
        execute = getattr(schema, "verify_stack", None)
        self.assertTrue(callable(execute), "A failed restart must stop the upgrade")
        stack = Mock()
        stack.transition_platform.side_effect = ValueError("transition failed")
        with self.assertRaisesRegex(ValueError, "transition failed"):
            execute(
                stack,
                "upgrade",
                ["base", "candidate"],
                "cli",
                TRANSITION,
                "candidate.yml",
                True,
            )
        stack.apply.assert_called_once_with("base", "cli")
        stack.artifacts.assert_not_called()
        stack.close.assert_called_once_with()

    def test_transition_recreates_only_postgres_and_never_reinserts_data(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "init.sql").write_bytes(platform()[INIT])
            stack = schema.DisposableStack(folder, folder, folder / "base.yml")
            base = platform()[COMPOSE]
            candidate = copy.deepcopy(base)
            candidate["services"]["postgres"]["command"] += [
                "-c",
                "supautils.hint_roles=",
            ]
            stack.resolved_compose = Mock(return_value=candidate)
            stack.classify_platform = Mock(return_value=TRANSITION)
            stack.resources = Mock(return_value=[])
            stack.sql = Mock()
            snapshot = {
                "owner": stack.project,
                "data": "sentinel",
                "system": "123",
                "migrations": ["1"],
                "schema": "hash",
                "volumes": {"pgdata": "original"},
            }
            stack.continuity_snapshot = Mock(
                side_effect=[snapshot, copy.deepcopy(snapshot)]
            )
            events = []
            for name in (
                "compose",
                "wait_sql_ready",
                "refresh_connection",
                "verify_permission_errors",
                "wait_api_ready",
            ):
                setattr(
                    stack,
                    name,
                    Mock(
                        side_effect=lambda *args, name=name, **kwargs: events.append(
                            name
                        )
                    ),
                )
            with patch.object(
                schema.uuid, "uuid4", return_value=SimpleNamespace(hex="sentinel")
            ), patch.object(schema, "sanitize_compose", return_value={"safe": True}):
                stack.transition_platform(TRANSITION, folder / "candidate.yml")
            self.assertEqual(
                events,
                [
                    "compose",
                    "wait_sql_ready",
                    "refresh_connection",
                    "verify_permission_errors",
                    "wait_api_ready",
                ],
            )
            stack.compose.assert_called_once_with(
                "up",
                "-d",
                "--no-deps",
                "--force-recreate",
                "postgres",
                label="same-volume platform transition",
            )
            self.assertEqual(stack.sql.call_count, 1)

    def test_transition_restart_or_data_loss_stops_before_api_and_artifacts(self):
        for failure in ("restart", "data"):
            with self.subTest(
                failure=failure
            ), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                (folder / "init.sql").write_bytes(platform()[INIT])
                stack = schema.DisposableStack(folder, folder, folder / "base.yml")
                base = platform()[COMPOSE]
                candidate = copy.deepcopy(base)
                candidate["services"]["postgres"]["command"] += [
                    "-c",
                    "supautils.hint_roles=",
                ]
                stack.resolved_compose = Mock(return_value=candidate)
                stack.classify_platform = Mock(return_value=TRANSITION)
                stack.resources = Mock(return_value=[])
                stack.sql = Mock()
                before = {
                    "owner": stack.project,
                    "data": "sentinel",
                    "system": "123",
                    "migrations": ["1"],
                    "schema": "hash",
                    "volumes": {"pgdata": "original"},
                }
                after = {**before, "data": ""}
                stack.continuity_snapshot = Mock(side_effect=[before, after])
                stack.compose = Mock(
                    side_effect=ValueError("restart failed")
                    if failure == "restart"
                    else None
                )
                for name in (
                    "wait_sql_ready",
                    "refresh_connection",
                    "verify_permission_errors",
                    "wait_api_ready",
                ):
                    setattr(stack, name, Mock())
                with patch.object(
                    schema.uuid, "uuid4", return_value=SimpleNamespace(hex="sentinel")
                ), patch.object(
                    schema, "sanitize_compose", return_value={"safe": True}
                ), self.assertRaisesRegex(ValueError, "restart failed|continuity"):
                    stack.transition_platform(TRANSITION, folder / "candidate.yml")
                stack.wait_api_ready.assert_not_called()
                self.assertEqual(stack.sql.call_count, 1)
                if failure == "restart":
                    stack.verify_permission_errors.assert_not_called()

    def test_permission_probe_timeout_has_a_controlled_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            stack = schema.DisposableStack(folder, folder, folder / "source.yml")
            stack.sql = Mock(return_value="")
            with patch.object(
                schema.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired("synthetic", 30),
            ), self.assertRaisesRegex(ValueError, "permission probe.*timed out"):
                stack.verify_permission_errors()


class StudioAdapterTests(unittest.TestCase):
    def setUp(self):
        self.queries = []

        def query(body):
            self.queries.append(json.loads(body))
            return [{"synthetic": "catalog proof"}]

        self.server = schema.http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            schema.studio_schema_adapter(b'{"swagger":"2.0"}', "SELECT 1;", query),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, path, body):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_port}{path}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, None

    def test_real_generator_endpoint_returns_allocated_catalog_proof(self):
        status, result = self.post(
            "/api/platform/pg-meta/default/query", {"query": "SELECT 1;"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(result, [{"synthetic": "catalog proof"}])
        self.assertEqual(self.queries, [{"query": "SELECT 1;"}])

    def test_arbitrary_query_and_extra_execution_options_are_rejected(self):
        for body in (
            {"query": "DROP TABLE example"},
            {"query": "SELECT 1;", "connection": "another"},
        ):
            with self.subTest(body=body):
                status, _ = self.post("/api/platform/pg-meta/default/query", body)
                self.assertEqual(status, 400)
        self.assertEqual(self.queries, [])

    def test_other_studio_projects_are_rejected(self):
        status, _ = self.post(
            "/api/platform/pg-meta/another/query", {"query": "SELECT 1;"}
        )
        self.assertEqual(status, 404)
        self.assertEqual(self.queries, [])


class RevisionInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="carbon-schema-input-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.helper = self.root / "scripts/lib/example.ts"
        self.helper.parent.mkdir(parents=True)
        self.helper.write_text("export const example = true;\n")
        self.git("init", "-q")
        self.git("config", "user.name", "Synthetic Test")
        self.git("config", "user.email", "test@example.com")
        self.git("add", "scripts/lib/example.ts")
        self.git("commit", "-qm", "synthetic base")
        self.revision = self.git("rev-parse", "HEAD")

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.root), *args], text=True
        ).strip()

    def test_deleted_committed_generator_cannot_attest_head(self):
        self.helper.unlink()
        with self.assertRaisesRegex(ValueError, "uncommitted"):
            schema.check_revision_inputs(self.root, self.revision)

    def test_candidate_cannot_be_its_own_upgrade_baseline(self):
        with self.assertRaisesRegex(ValueError, "precede"):
            schema.check_upgrade_baseline(self.root, self.revision, self.revision)

    def test_real_prior_commit_is_an_upgrade_baseline(self):
        self.helper.write_text("export const example = false;\n")
        self.git("add", "scripts/lib/example.ts")
        self.git("commit", "-qm", "synthetic candidate")
        schema.check_upgrade_baseline(
            self.root, self.revision, self.git("rev-parse", "HEAD")
        )

    def test_sql_proof_is_a_generator_input(self):
        path = "scripts/lib/swagger-partner-alias.sql"
        (self.root / path).write_text("SELECT 1;\n")
        self.assertIn(path, schema.generation_inputs(self.root))


class CommandModeTests(unittest.TestCase):
    """Exercise argument parsing, real Git snapshots and tool pins before fake infrastructure."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="carbon-schema-command-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        repository = Path(__file__).parents[2]
        for name in ("schema.py", "verify.py", "generated-artifacts.json"):
            self.write(f".fork/{name}", (repository / ".fork" / name).read_bytes())
        self.write("pnpm-workspace.yaml", b"catalog:\n  supabase: 2.89.0\n")
        self.write(COMPOSE, b"services: {}\n")
        self.write(INIT, b"-- synthetic bootstrap\n")
        self.old_migration = PREFIX + "20260908010101_original.sql"
        self.write(self.old_migration, b"SELECT 1;\n")
        for path in schema.ARTIFACTS.values():
            self.write(path, b"synthetic committed artifact\n")
        self.git("init", "-q")
        self.git("config", "user.name", "Synthetic Test")
        self.git("config", "user.email", "test@example.com")
        self.git("add", ".fork", "pnpm-workspace.yaml", "packages")
        self.git("commit", "-qm", "synthetic baseline")
        self.base = self.git("rev-parse", "HEAD")
        self.cli = self.root / "node_modules/.bin/supabase"
        self.install_cli("2.89.0")
        self.stacks = []
        self.output = io.StringIO()

    def write(self, path, content):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.root), *args], text=True
        ).strip()

    def install_cli(self, version):
        self.write(
            "node_modules/.bin/supabase",
            f"#!/bin/sh\nprintf '%s\\n' '{version}'\n".encode(),
        )
        self.cli.chmod(0o755)

    def commit_candidate(self):
        self.write("candidate.txt", b"synthetic candidate\n")
        self.git("add", "candidate.txt")
        self.git("commit", "-qm", "synthetic candidate")

    def invoke(self, *, regenerate=False, base=None):
        real_run = schema.run

        def run(args, **kwargs):
            if args[0] == "docker":
                return (
                    b"unix:///synthetic/docker.sock\n"
                    if args[1] == "context"
                    else b"{}"
                )
            if "canonical" in args:
                return b"same\n"
            return real_run(args, **kwargs)

        def allocate(*args):
            stack = Mock()
            stack.resolved_compose.return_value = {
                "services": {"postgres": {"command": []}}
            }
            stack.classify_platform.return_value = None
            stack.fingerprint.return_value = "same-schema"
            stack.artifacts.return_value = {kind: "same" for kind in schema.ARTIFACTS}
            self.stacks.append(stack)
            return stack

        arguments = ["schema.py", "--base", base or self.base]
        if regenerate:
            arguments.append("--regenerate")
        with patch.object(
            schema, "__file__", str(self.root / ".fork/schema.py")
        ), patch.object(schema.sys, "argv", arguments), patch.object(
            schema, "run", side_effect=run
        ), patch.object(
            schema, "DisposableStack", side_effect=allocate
        ), contextlib.redirect_stdout(self.output):
            schema.main()
        reports = list((self.root / ".fork/local/schema-runs").glob("*/report.json"))
        return json.loads(reports[-1].read_text())

    def test_regenerate_at_reviewed_head_uses_worktree_and_remains_unverified(self):
        added = PREFIX + "20260908020202_reconciled.sql"
        self.write(added, b"SELECT 2;\n")
        report = self.invoke(regenerate=True)
        self.assertEqual(report["status"], "generated-unverified")
        self.assertEqual(set(report["results"]), {"fresh"})
        self.assertIn("GENERATED/UNVERIFIED", self.output.getvalue())
        self.assertIn(added, self.stacks[-1].apply.call_args.args[0])
        self.assertEqual(self.git("rev-parse", "HEAD"), self.base)

    def test_strict_command_rejects_equal_base_before_infrastructure(self):
        with self.assertRaisesRegex(ValueError, "precede"):
            self.invoke()
        self.assertEqual(self.stacks, [])

    def test_regenerate_uses_reconciled_catalog_pin(self):
        self.commit_candidate()
        self.write("pnpm-workspace.yaml", b"catalog:\n  supabase: 2.90.0\n")
        self.install_cli("2.90.0")
        self.assertEqual(self.invoke(regenerate=True)["cli"], "2.90.0")

    def test_regenerate_rejects_installed_head_pin_after_catalog_reconciliation(self):
        self.commit_candidate()
        self.write("pnpm-workspace.yaml", b"catalog:\n  supabase: 2.90.0\n")
        with self.assertRaisesRegex(ValueError, "CLI version differs"):
            self.invoke(regenerate=True)
        self.assertEqual(self.stacks, [])

    def test_strict_command_uses_committed_pin_and_both_migration_paths(self):
        self.commit_candidate()
        report = self.invoke()
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["results"]), {"fresh", "upgrade"})
        self.assertEqual(report["cli"], "2.89.0")
        self.assertEqual(self.stacks[-1].apply.call_count, 2)

    def test_strict_command_rejects_uncommitted_catalog_even_with_matching_cli(self):
        self.commit_candidate()
        self.write("pnpm-workspace.yaml", b"catalog:\n  supabase: 2.90.0\n")
        self.install_cli("2.90.0")
        with self.assertRaisesRegex(ValueError, "uncommitted"):
            self.invoke()
        self.assertEqual(self.stacks, [])

    def test_regenerate_rejects_missing_invalid_and_ambiguous_catalog_pins(self):
        self.commit_candidate()
        for catalog in (
            b"catalog: {}\n",
            b"catalog:\n  supabase: latest\n",
            b"catalog:\n  supabase: ^2.89.0\n",
            b"catalog:\n  supabase: 2.89.0\n  supabase: 2.90.0\n",
            b"catalog:\n  supabase: 2..0\n",
        ):
            self.write("pnpm-workspace.yaml", catalog)
            with self.subTest(catalog=catalog), self.assertRaisesRegex(
                ValueError, "Supabase.*pin"
            ):
                self.invoke(regenerate=True)
        self.assertEqual(self.stacks, [])

    def test_regenerate_still_rejects_changed_or_deleted_historical_sql(self):
        self.write(PREFIX + "20260908020202_reconciled.sql", b"SELECT 2;\n")
        for content in (b"SELECT 9;\n", None):
            if content is None:
                (self.root / self.old_migration).unlink()
            else:
                self.write(self.old_migration, content)
            with self.subTest(content=content), self.assertRaisesRegex(
                ValueError, "historical migration"
            ):
                self.invoke(regenerate=True)
        self.assertEqual(self.stacks, [])

    def test_command_rejects_equivalent_duplicate_catalog_keys(self):
        self.commit_candidate()
        for key in (b"supabase ", b"'supabase'", b'"supabase"'):
            self.write(
                "pnpm-workspace.yaml",
                b"catalog:\n  supabase: 2.89.0\n  " + key + b": 2.90.0\n",
            )
            with self.subTest(key=key), self.assertRaisesRegex(
                ValueError, "Supabase.*pin"
            ):
                self.invoke(regenerate=True)

    def test_command_rejects_nested_or_scalar_text_as_a_catalog_pin(self):
        self.commit_candidate()
        for catalog in (
            b"catalog:\n  group:\n    supabase: 2.89.0\n",
            b"catalog:\n  description: |\n    supabase: 2.89.0\n",
        ):
            self.write("pnpm-workspace.yaml", catalog)
            with self.subTest(catalog=catalog), self.assertRaisesRegex(
                ValueError, "Supabase.*pin"
            ):
                self.invoke(regenerate=True)
        self.assertEqual(self.stacks, [])

    def test_command_rejects_equivalent_duplicate_root_catalog_keys(self):
        self.commit_candidate()
        for key in (b"catalog ", b"'catalog'", b'"catalog"'):
            self.write(
                "pnpm-workspace.yaml",
                b"catalog:\n  supabase: 2.89.0\n" + key + b":\n  supabase: 2.90.0\n",
            )
            with self.subTest(key=key), self.assertRaisesRegex(
                ValueError, "Supabase.*pin"
            ):
                self.invoke(regenerate=True)
        self.assertEqual(self.stacks, [])

    def test_strict_command_rejects_invalid_committed_pin(self):
        self.write("pnpm-workspace.yaml", b"catalog:\n  supabase: latest\n")
        self.git("add", "pnpm-workspace.yaml")
        self.git("commit", "-qm", "synthetic invalid catalog")
        with self.assertRaisesRegex(ValueError, "Supabase.*pin"):
            self.invoke()
        self.assertEqual(self.stacks, [])

    def test_command_rejects_missing_installed_cli_in_both_modes(self):
        self.commit_candidate()
        self.cli.unlink()
        for regenerate in (False, True):
            with self.subTest(regenerate=regenerate), self.assertRaisesRegex(
                ValueError, "CLI is missing"
            ):
                self.invoke(regenerate=regenerate)
        self.assertEqual(self.stacks, [])

    def test_regenerate_still_rejects_a_nonancestor_base(self):
        self.commit_candidate()
        unrelated = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", self.base)
        with self.assertRaisesRegex(ValueError, "Git snapshot failed"):
            self.invoke(regenerate=True, base=unrelated)
        self.assertEqual(self.stacks, [])


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
