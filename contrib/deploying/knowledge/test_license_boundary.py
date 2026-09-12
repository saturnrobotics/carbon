"""Knowledge images must exclude enterprise-licensed code and carry the license. Offline; no Docker."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("license_boundary", HERE / "verify-license-boundary.py")
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)

PINNED = "node:22-alpine@sha256:" + "a" * 64
DOCKERFILE = (
    f"ARG NODE_IMAGE={PINNED}\n"
    "FROM ${NODE_IMAGE} AS pruner\n"
    "RUN corepack pnpm dlx turbo@2.9.6 prune TARGET --docker\n"
    "FROM ${NODE_IMAGE} AS builder\n"
    "COPY --from=pruner /repo/out/full/ ./\n"
    "COPY LICENSE ./LICENSE\n"
    "FROM builder AS e2e\n"
    "FROM ${NODE_IMAGE} AS runtime\n"
    "COPY --from=builder /runtime ./\n"
    "RUNTIME_LICENSE"
)


def synthetic_workspace(directory):
    root = Path(directory)
    (root / "pnpm-workspace.yaml").write_text("packages:\n  - apps/*\n  - packages/*\n\noverrides: {}\n")
    (root / "LICENSE").write_text("synthetic license\n")
    manifests = {
        "packages/ee": {"name": "@carbon/ee"},
        "packages/core": {"name": "@carbon/core", "devDependencies": {"@carbon/ee": "workspace:*"}},
        "packages/tainted": {"name": "@carbon/tainted"},
        "apps/clean": {"name": "clean", "dependencies": {"@carbon/core": "workspace:*"}},
        "apps/enterprise": {"name": "enterprise", "dependencies": {"@carbon/ee": "workspace:*"}},
        "apps/tainted": {"name": "tainted", "dependencies": {"@carbon/tainted": "workspace:*"}},
        "apps/dev-only": {"name": "dev-only", "devDependencies": {"@carbon/tainted": "workspace:*"}},
    }
    for path, manifest in manifests.items():
        (root / path).mkdir(parents=True)
        (root / path / "package.json").write_text(json.dumps(manifest))
    (root / "packages/tainted/src").mkdir()
    (root / "packages/tainted/src/report.ee.ts").write_text("export {};\n")
    (root / "packages/tainted/node_modules/vendor").mkdir(parents=True)
    (root / "packages/tainted/node_modules/vendor/thing.ee.js").write_text("")
    return root


def dockerfile(root, target, runtime_license=True):
    path = root / f"Dockerfile.{target}"
    path.write_text(DOCKERFILE.replace("TARGET", target).replace("RUNTIME_LICENSE", "COPY LICENSE ./LICENSE\n" if runtime_license else ""))
    return path


class StaticClosureTests(unittest.TestCase):
    def test_closures_follow_workspace_edges_and_production_drops_dev_edges(self):
        with tempfile.TemporaryDirectory() as directory:
            root = synthetic_workspace(directory)
            self.assertEqual(set(boundary.workspace_closure(root, ["clean"])), {"clean", "@carbon/core", "@carbon/ee"})
            self.assertEqual(set(boundary.workspace_closure(root, ["clean"], production=True)), {"clean", "@carbon/core"})
            with self.assertRaisesRegex(ValueError, "Unknown workspace package"):
                boundary.workspace_closure(root, ["missing"])

    def test_enterprise_package_is_refused_anywhere_in_the_build_closure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = synthetic_workspace(directory)
            for target in ("clean", "enterprise"):
                with self.subTest(target=target), self.assertRaisesRegex(ValueError, "enterprise package: @carbon/ee"):
                    boundary.check_dockerfile(root, dockerfile(root, target))

    def test_enterprise_files_are_refused_only_when_shipped_by_pnpm_deploy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = synthetic_workspace(directory)
            with self.assertRaisesRegex(ValueError, r"runtime closure includes 1 enterprise-licensed files: packages/tainted/src/report\.ee\.ts"):
                boundary.check_dockerfile(root, dockerfile(root, "tainted"))
            result = boundary.check_dockerfile(root, dockerfile(root, "dev-only"))
            self.assertEqual(result, {"targets": ["dev-only"], "closure": ["dev-only"], "shipped": ["e2e", "runtime"]})

    def test_every_shipped_stage_must_copy_or_inherit_the_license(self):
        with tempfile.TemporaryDirectory() as directory:
            root = synthetic_workspace(directory)
            with self.assertRaisesRegex(ValueError, "stage runtime does not copy LICENSE"):
                boundary.check_dockerfile(root, dockerfile(root, "dev-only", runtime_license=False))
            (root / "NOTICE").write_text("third-party notices\n")
            with self.assertRaisesRegex(ValueError, "stage e2e does not copy NOTICE"):
                boundary.check_dockerfile(root, dockerfile(root, "dev-only"))
            single = root / "Dockerfile.probe"
            single.write_text(f"ARG NODE_IMAGE={PINNED}\nFROM ${{NODE_IMAGE}}\nCOPY server.ts ./server.ts\n")
            with self.assertRaisesRegex(ValueError, "stage the image does not copy LICENSE, NOTICE"):
                boundary.check_dockerfile(root, single)

    def test_repository_knowledge_dockerfiles_pass(self):
        packages = boundary.workspace_packages(boundary.ROOT)
        self.assertIn("@carbon/ee", packages)
        for path in boundary.base_images.dockerfile_paths():
            with self.subTest(dockerfile=path.name):
                result = boundary.check_dockerfile(boundary.ROOT, path, packages)
                self.assertNotIn("@carbon/ee", result["closure"])
                self.assertIn("runtime" if path.name != "Dockerfile.probe" else "", result["shipped"])


class ImageEntryTests(unittest.TestCase):
    def test_exported_image_must_carry_the_license_beside_the_code_and_no_enterprise_paths(self):
        clean = ["app/", "app/LICENSE", "app/dist/index.js", "app/node_modules/@carbon/utils/index.js", "app/node_modules/vendor/x.ee.js"]
        boundary.check_image_entries(clean, "/app", ["LICENSE"])
        boundary.check_image_entries(["repo/LICENSE", "repo/apps/web/build/index.js"], "/repo/apps/web", ["LICENSE"])
        for entries, reason in (
            (["app/dist/index.js"], "carry no LICENSE"),
            (["LICENSE", "app/dist/index.js"], None),
            (["app/LICENSE", "app/node_modules/@carbon/ee/index.js"], "enterprise-licensed paths"),
            (["app/LICENSE", "repo/packages/ee/src/index.ts"], "enterprise-licensed paths"),
            (["app/LICENSE", "app/dist/accounting.ee.js"], "enterprise-licensed paths"),
        ):
            with self.subTest(entries=entries):
                if reason is None:
                    boundary.check_image_entries(entries, "/app", ["LICENSE"])
                else:
                    with self.assertRaisesRegex(ValueError, reason):
                        boundary.check_image_entries(entries, "/app", ["LICENSE"])
        with self.assertRaisesRegex(ValueError, "carry no NOTICE"):
            boundary.check_image_entries(clean, "/app", ["LICENSE", "NOTICE"])


if __name__ == "__main__":
    unittest.main()
