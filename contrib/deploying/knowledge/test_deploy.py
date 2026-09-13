"""Deployment orchestration tests. Cloud writes are simulated at the adapter boundary."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


class DeploymentEntryTests(unittest.TestCase):
    def test_missing_setup_explains_the_private_config_before_running_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, str(HERE / "deploy.py"), "--config", str(Path(directory) / "deploy.json"), "--apply"],
                text=True, capture_output=True,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Knowledge deployment is not configured", result.stderr)
        self.assertIn("deploy.example.json", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_make_exposes_apply_and_read_only_check(self):
        for target, flag in (("deploy-knowledge", "--apply"), ("deploy-knowledge-check", "--check")):
            with self.subTest(target=target):
                result = subprocess.run(["make", "-n", target], cwd=ROOT, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("contrib/deploying/knowledge/deploy.py", result.stdout)
                self.assertIn(flag, result.stdout)


def module():
    sys.path.insert(0, str(HERE))
    spec = importlib.util.spec_from_file_location("knowledge_deploy", HERE / "deploy.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.deploy = module()

    def test_schema_failure_stops_before_any_application_promotion(self):
        self.assertTrue(callable(getattr(self.deploy, "release_units", None)), "Missing deployment orchestration")
        self.exercise(schema_failure=True)

    def test_schema_is_observed_again_before_dependency_ordered_promotion(self):
        self.assertTrue(callable(getattr(self.deploy, "release_units", None)), "Missing deployment orchestration")
        events = self.exercise()
        self.assertEqual(events, ["read-ledger", "knowledge-schema", "execute-schema", "read-ledger",
                                  "knowledge-parser", "knowledge-query", "knowledge-ingest", "knowledge-retention", "knowledge-web"])

    def test_successful_steps_survive_failure_and_retry_skips_them(self):
        self.assertTrue(callable(getattr(self.deploy, "release_units", None)), "Missing deployment orchestration")
        self.exercise(fail_unit="knowledge-ingest")

    def test_unchanged_release_does_not_replace_or_execute_jobs(self):
        self.assertTrue(callable(getattr(self.deploy, "release_units", None)), "Missing deployment orchestration")
        self.exercise(noop=True)

    def test_migration_success_with_wrong_ledger_stops_release(self):
        self.assertTrue(callable(getattr(self.deploy, "release_units", None)), "Missing deployment orchestration")
        self.exercise(stale_ledger=True)

    def exercise(self, *, schema_failure=False, fail_unit=None, noop=False, stale_ledger=False):
        from test_release import database_plan, plan, ledger, LAST
        release = self.deploy.release
        services = {"knowledge-web": plan()["services"]["knowledge-web"]}
        for name in release.DATABASE_UNITS:
            services.update(database_plan(name)["services"])
        services["knowledge-parser"] = dict(services["knowledge-web"], kind="job", environment={}, secrets={})
        candidate = dict(plan(), services=services)
        candidate["build_receipt"] = {name: {"image": spec["image"], "image_digest": spec["image"].split("@")[1], "source_commit": candidate["source_commit"]} for name, spec in services.items()}
        events = []
        snapshots = [ledger(LAST)] if noop else [ledger(), ledger() if stale_ledger else ledger(LAST)]
        def read():
            events.append("read-ledger")
            return snapshots.pop(0) if len(snapshots) > 1 else snapshots[0]
        def promote(selected, current, **kwargs):
            name = next(iter(selected["deploy"]))
            events.append(name)
            if name == fail_unit:
                raise ValueError("synthetic promotion failure")
            release.save_manifest(kwargs["manifest"], selected, current, [{"name": name, "revision_digest": release.revision_digest(services[name]), "deployed_revision": "synthetic-new"}])
        class Adapter:
            def call(self, args, *, capture=False):
                if "execute" in args:
                    events.append("execute-schema")
                    if schema_failure:
                        raise ValueError("synthetic schema failure")
                return ""
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "promote", side_effect=promote):
            manifest = Path(directory) / "manifest.json"
            current = {"generation": 0, "services": {}}
            if noop:
                current["services"] = {name: {"revision_digest": release.revision_digest(spec)} for name, spec in services.items()}
            manifest.write_text(json.dumps(current))
            def invoke():
                return self.deploy.release_units(candidate, manifest, project="example", region="us-east1", adapter=Adapter(), read_ledger=read, migration_names=[LAST])
            if schema_failure or fail_unit or stale_ledger:
                with self.assertRaises(ValueError):
                    invoke()
                self.assertNotIn("knowledge-web", events)
                if schema_failure or stale_ledger:
                    self.assertNotIn("knowledge-query", events)
                if fail_unit:
                    saved = json.loads(manifest.read_text())
                    self.assertIn("knowledge-query", saved["services"])
                    self.assertNotIn(fail_unit, saved["services"])
                    fail_unit = None
                    events.clear()
                    invoke()
                    self.assertEqual(events, ["read-ledger", "knowledge-ingest", "knowledge-retention", "knowledge-web"])
            else:
                invoke()
                if noop:
                    self.assertEqual(events, ["read-ledger"])
        return events

    def test_runtime_requires_current_schema_and_schema_can_bootstrap(self):
        self.assertTrue(callable(getattr(self.deploy, "prepare_plan", None)), "Missing plan preparation")
        from test_release import database_plan, foundation_outputs, FIRST, LAST
        config = {"services": {**database_plan()["services"], **database_plan("knowledge-schema")["services"]}}
        candidate = self.deploy.prepare_plan(config, "a" * 40, foundation_outputs(), [FIRST, LAST])
        self.assertEqual(candidate["services"]["knowledge-query"]["migrations"], {"minimum": LAST, "maximum": LAST})
        self.assertEqual(candidate["services"]["knowledge-schema"]["migrations"], {"minimum": FIRST, "maximum": LAST})
        self.assertEqual(candidate["deploy"], {})

    def test_conflicting_manual_libraries_fail_before_build(self):
        from test_release import database_plan, foundation_outputs, plan, FIRST, LAST
        config = {"services": {**plan()["services"], **database_plan()["services"]}}
        environment = config["services"]["knowledge-query"]["environment"]
        environment["KNOWLEDGE_MANUAL_SOURCE_JSON"] = '{"sourceId":"different","displayName":"Different library"}'
        # Populate synthetic foundation audiences in the existing web fixture.
        for key, receiver in self.deploy.release.AUDIENCE_ENVIRONMENT["knowledge-web"].items():
            config["services"]["knowledge-web"]["environment"][key] = foundation_outputs()["service_audiences"]["value"][receiver]
        with self.assertRaisesRegex(ValueError, "same manual library"):
            self.deploy.prepare_plan(config, "a" * 40, foundation_outputs(), [FIRST, LAST])

    def test_tracked_archive_cannot_include_ignored_or_untracked_secrets(self):
        self.assertTrue(callable(getattr(self.deploy, "archive_source", None)), "Missing immutable build context")
        import tarfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True).stdout.strip()
            git("init")
            (root / ".gitignore").write_text(".env\n")
            (root / "public.txt").write_text("reviewed")
            git("add", ".gitignore", "public.txt")
            git("-c", "user.name=Synthetic", "-c", "user.email=example@example.com", "commit", "-m", "fixture")
            revision = git("rev-parse", "HEAD")
            (root / ".env").write_text("synthetic-private")
            (root / "untracked.txt").write_text("synthetic-private")
            (root / "public.txt").write_text("uncommitted")
            archive = root / "source.tar"
            self.deploy.archive_source(root, revision, archive)
            with tarfile.open(archive) as snapshot:
                self.assertEqual(set(snapshot.getnames()), {".gitignore", "public.txt"})
                self.assertEqual(snapshot.extractfile("public.txt").read(), b"reviewed")


class BuildAndPreflightTests(unittest.TestCase):
    def setUp(self):
        self.deploy = module()

    def test_build_receipts_reuse_same_source_and_pin_registry_digest(self):
        self.assertTrue(callable(getattr(self.deploy, "build_images", None)), "Missing automated image build")
        from test_release import plan
        calls = []
        class Adapter:
            def call(self, args, *, capture=False, input_path=None):
                calls.append(args)
                if "build" in args:
                    self.assert_input = input_path
                    Path(args[args.index("--metadata-file") + 1]).write_text(json.dumps({"containerimage.digest": "sha256:" + "b" * 64}))
                return ""
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            archive = state / "source.tar"
            archive.write_bytes(b"synthetic archive")
            candidate = plan()
            self.deploy.build_images(candidate, "us-east1-docker.pkg.dev/example/knowledge", state, archive, Adapter())
            self.assertEqual(candidate["services"]["knowledge-web"]["image"], "us-east1-docker.pkg.dev/example/knowledge/web@sha256:" + "b" * 64)
            self.assertEqual(candidate["build_receipt"]["knowledge-web"]["source_commit"], "a" * 40)
            builds = [args for args in calls if "build" in args]
            self.assertEqual(len(builds), 1)
            self.assertIn("linux/amd64", builds[0])
            self.assertIn("--push", builds[0])
            self.assertIn("runtime", builds[0])
            self.assertEqual(builds[0][-1], "-")
            self.deploy.build_images(plan(), "us-east1-docker.pkg.dev/example/knowledge", state, archive, Adapter())
            self.assertEqual(len([args for args in calls if "build" in args]), 1)
            self.assertTrue(any("describe" in args for args in calls))

    def test_foreign_schema_is_rejected_before_execution(self):
        with self.assertRaisesRegex(ValueError, "not a prefix"):
            self.deploy.check_ledger({"schema_version": 1, "names": ["20990101000000_unknown"]}, ["20260908000245_knowledge-foundation"])

    def test_template_cannot_be_deployed_with_placeholder_values(self):
        self.assertTrue(callable(getattr(self.deploy, "validate_config", None)), "Missing configuration preflight")
        template = json.loads((HERE / "deploy.example.json").read_text())
        with self.assertRaisesRegex(ValueError, "Replace.*placeholder"):
            self.deploy.validate_config(template)

    def test_private_provider_failure_is_not_printed(self):
        self.assertTrue(callable(getattr(self.deploy, "Commands", None)), "Missing private command logging")
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "commands.log"
            runner = self.deploy.Commands(log)
            with self.assertRaises(subprocess.CalledProcessError) as error:
                runner.call([sys.executable, "-c", "import sys; print('synthetic-private-value', file=sys.stderr); sys.exit(9)"])
            self.assertNotIn("synthetic-private-value", str(error.exception))
            self.assertIn("synthetic-private-value", log.read_text())
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
