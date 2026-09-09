"""Prove real ignore rules and staged snapshots protect private artifacts."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).parents[2]
SPEC = importlib.util.spec_from_file_location(
    "privacy_verify", ROOT / ".fork/verify.py"
)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)

PRIVATE_PATHS = (
    ".env",
    ".env.test",
    ".env.staging",
    ".envrc",
    ".envrc.local",
    ".env_backup",
    ".env.example.local",
    ".terraform/providers/provider",
    ".terraform/environment",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    ".terraform.tfstate.lock.info",
    "release.tfplan",
    "release.tfplan.json",
    "tfplan",
    "tfplan.json",
    "production.tfvars",
    "production.auto.tfvars",
    "production.tfvars.json",
    ".terraformrc",
    "terraform.rc",
    "credentials.tfrc.json",
    "crash.log",
    "crash.20260101.log",
    ".docker/config.json",
    ".buildx/cache/index.json",
    ".buildkit/cache/index.json",
    ".docker-build/image.tar",
    ".docker-cache/index.json",
    ".docker-images/image.tar",
    ".docker-data/volume/data",
    "release.docker.tar",
    "release.docker.tar.gz",
    "release.oci.tar",
    "release.oci.tar.zst",
    ".local/private.json",
    ".local/.env.example",
    ".secrets/token",
    "secrets/token",
    "runtime.secret",
    ".cert/key.pem",
    "test-results/report.json",
    "playwright-report/report.html",
)

PUBLIC_PATHS = (
    "main.tf",
    "main.tf.json",
    ".terraform.lock.hcl",
    "production.tfvars.example",
    "production.tfvars.json.example",
    ".env.example",
    ".env.production.example",
    ".envrc.example",
    "Dockerfile",
    "Dockerfile.web",
    "Dockerfile.dockerignore",
    "compose.yaml",
    "compose.local.yaml",
    "docker-compose.yml",
    "secrets.example.json",
    "secrets.ts",
    "fixtures/example.tar",
    "fixtures/example.json",
)


class PrivacyArtifactsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="carbon-privacy-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.com")
        self.git("config", "user.name", "Privacy fixture")
        policy = json.loads((ROOT / ".fork/generated-artifacts.json").read_text())
        policy["artifacts"] = []
        policy["identical_copies"] = []
        self.write(".fork/generated-artifacts.json", json.dumps(policy))
        self.write(".gitignore", (ROOT / ".gitignore").read_text())
        self.write("AGENTS.md", "Read .fork/agent-policy.md.\n")
        self.write(".fork/agent-policy.md", "Keep private runtime inputs local.\n")
        self.write("package.json", '{"packageManager":"pnpm@10.33.4"}\n')
        self.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
        self.git("add", ".")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture")

    def git(self, *args, input=None, check=True):
        return subprocess.run(
            ["git", "-C", str(self.root), *args],
            input=input,
            text=True,
            capture_output=True,
            check=check,
        )

    def write(self, name, contents="{}\n"):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)

    def ignored(self, paths):
        result = self.git(
            "check-ignore",
            "--no-index",
            "-z",
            "--stdin",
            input="\0".join(paths) + "\0",
            check=False,
        )
        self.assertIn(result.returncode, (0, 1))
        return set(result.stdout.rstrip("\0").split("\0")) - {""}

    def test_private_artifacts_are_ignored_at_root_and_new_nested_locations(self):
        paths = {
            prefix + path
            for prefix in ("", "infra/new-service/")
            for path in PRIVATE_PATHS
        }
        self.assertEqual(self.ignored(paths), paths)

    def test_reviewable_source_and_example_templates_remain_visible(self):
        paths = {
            prefix + path
            for prefix in ("", "infra/new-service/")
            for path in PUBLIC_PATHS
        }
        self.assertEqual(self.ignored(paths), set())
        for path in paths:
            self.write(path)
        self.git("add", "--", *sorted(paths))
        self.assertEqual(verify.preflight(self.root, "index"), [])

    def test_existing_nested_ignore_files_cannot_reinclude_runtime_environment(self):
        directories = (
            "contrib/building/examples/quote-configurator/",
            "contrib/building/examples/upload-3d-model/",
        )
        for directory in directories:
            self.write(
                directory + ".gitignore", (ROOT / directory / ".gitignore").read_text()
            )
        private = {
            directory + path for directory in directories for path in PRIVATE_PATHS
        }
        public = {
            directory + path for directory in directories for path in PUBLIC_PATHS
        }
        self.assertEqual(self.ignored(private), private)
        self.assertEqual(self.ignored(public), set())

    def test_force_added_private_artifacts_are_rejected_in_index_and_commit(self):
        paths = {
            prefix + path
            for prefix in ("", "infra/new-service/")
            for path in PRIVATE_PATHS
        }
        for path in paths:
            self.write(path)
        self.git("add", "-f", "--", *sorted(paths))
        for revision in ("index", "HEAD"):
            if revision == "HEAD":
                self.git(
                    "-c",
                    "core.hooksPath=/dev/null",
                    "commit",
                    "-qm",
                    "synthetic negative fixture",
                )
            errors = verify.preflight(self.root, revision)
            rejected = {error.split(":", 1)[0] for error in errors}
            self.assertEqual(paths - rejected, set())

    def test_environment_directory_cannot_disguise_private_inputs_as_a_template(self):
        path = ".env.example/private.json"
        self.write(path)
        self.git("add", "-f", "--", path)
        self.assertTrue(
            any(path in error for error in verify.preflight(self.root, "index"))
        )

    def test_environment_allow_list_cannot_name_a_runtime_input(self):
        path = ".fork/generated-artifacts.json"
        policy = json.loads((self.root / path).read_text())
        policy["public_environment_templates"] = ["**/.env.production"]
        self.write(path, json.dumps(policy))
        self.git("add", "--", path)
        self.assertTrue(
            any(
                "invalid artifact policy" in error
                for error in verify.preflight(self.root, "index")
            )
        )

    def test_private_input_diagnostic_does_not_echo_content(self):
        sentinel = "synthetic-private-value-do-not-print"
        self.write(".env.staging", "EXAMPLE=" + sentinel + "\n")
        self.git("add", "-f", "--", ".env.staging")
        errors = verify.preflight(self.root, "index")
        self.assertTrue(any(".env.staging" in error for error in errors))
        self.assertNotIn(sentinel, "\n".join(errors))

    def run_actual_hook(self):
        return subprocess.run(
            ["sh", str(ROOT / ".fork/hooks/pre-commit")],
            cwd=self.root,
            text=True,
            capture_output=True,
        )

    def assert_private_rejection_before_dependencies(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".env.staging", result.stdout + result.stderr)
        self.assertNotIn("synthetic-hook-fixture", result.stdout + result.stderr)
        self.assertNotIn(
            "Fork commit checks need pinned dependencies", result.stdout + result.stderr
        )

    def test_actual_hook_rejects_force_added_environment_before_dependency_checks(self):
        self.write(".fork/verify.py", (ROOT / ".fork/verify.py").read_text())
        self.write(".env.staging", "EXAMPLE=synthetic-hook-fixture\n")
        self.git("add", "-f", "--", ".env.staging")
        self.assert_private_rejection_before_dependencies(self.run_actual_hook())

    def test_hook_fixture_rejects_a_successful_preflight_bypass(self):
        # A warning without a failure reaches the real hook's dependency check.
        # Preserve the filename output to prove this fixture checks execution
        # order, not merely the presence of a private-input diagnostic.
        self.write(".fork/verify.py", "print('.env.staging: synthetic warning only')\n")
        result = self.run_actual_hook()
        self.assertIn("Fork commit checks need pinned dependencies", result.stderr)
        with self.assertRaises(AssertionError):
            self.assert_private_rejection_before_dependencies(result)

    def test_every_docker_ignore_configuration_has_an_actual_context_fixture(self):
        listed = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        ignore_files = {
            path for path in listed.stdout.split("\0") if path.endswith(".dockerignore")
        }
        self.assertEqual(
            ignore_files,
            {
                ".dockerignore",
                "apps/assembler/Dockerfile.dockerignore",
                "apps/assembler/.dockerignore",
            },
        )

    def test_actual_docker_context_proof_is_required_by_source_ci(self):
        workflow = (ROOT / ".github/workflows/fork-check.yml").read_text()
        source = workflow.split("  source:\n", 1)[1].split("\n  schema:\n", 1)[0]
        self.assertIn(
            "python3 contrib/deploying/knowledge/verify-build-context.py", source
        )


if __name__ == "__main__":
    unittest.main()
