"""After installation, exercise real Biome project discovery and safe autofixes."""

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("fork_ci", ROOT / ".fork/ci.py")
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


class BiomeLiveTests(unittest.TestCase):
    def test_committed_authored_mcp_server_is_checked_despite_upstream_exclusion(self):
        with tempfile.TemporaryDirectory(prefix="carbon-mcp-lint-") as directory:
            root = Path(directory)
            (root / ".fork").mkdir()
            for name in ("biome.jsonc", ".fork/biome-check.json"):
                shutil.copyfile(ROOT / name, root / name)
            (root / ".fork/generated-artifacts.json").write_text('{"artifacts": []}')
            package_manager = json.loads((ROOT / "package.json").read_text())[
                "packageManager"
            ]
            (root / "package.json").write_text(
                json.dumps({"name": "lint-fixture", "packageManager": package_manager})
            )
            (root / "node_modules").symlink_to(
                ROOT / "node_modules", target_is_directory=True
            )
            (root / ".gitignore").write_text("node_modules/\n")
            name = "apps/erp/app/routes/api+/mcp+/lib/server.ts"
            path = root / name
            path.parent.mkdir(parents=True)
            path.write_text("export const fixture = 1;\n")

            def git(*arguments):
                return subprocess.check_output(
                    [
                        "git",
                        "-c",
                        "user.name=Fixture",
                        "-c",
                        "user.email=fixture@example.com",
                        *arguments,
                    ],
                    cwd=root,
                    text=True,
                ).strip()

            git("init", "-q")
            git("add", ".")
            git("commit", "-qm", "Baseline fixture")
            base = git("rev-parse", "HEAD")
            path.write_text("export const fixture = 2;\n")
            git("add", name)
            git("commit", "-qm", "Change authored MCP server")
            try:
                ci.lint(root, base)
            except ValueError as error:
                self.fail(f"A valid authored MCP server must be checked: {error}")
            path.write_text("export const fixture = missingRuntimeValue;\n")
            git("add", name)
            git("commit", "-qm", "Invalid authored MCP server")
            with self.assertRaisesRegex(ValueError, "Strict lint"):
                ci.lint(root, base)

    def test_deno_globals_are_scoped_without_hiding_unknown_names(self):
        with tempfile.TemporaryDirectory(prefix="carbon-deno-lint-") as directory:
            path = (
                Path(directory)
                / "packages/database/supabase/functions/example/example.test.ts"
            )
            path.parent.mkdir(parents=True)
            path.write_text('Deno.test("example", () => Promise.resolve());\n')
            result = ci.biome(ROOT, [str(path)], expanded=True, write=True)
            self.assertEqual(result.returncode, 0, result.stdout)
            path.write_text('Deno.test("example", () => missingRuntimeValue());\n')
            result = ci.biome(ROOT, [str(path)], expanded=True)
            self.assertNotEqual(result.returncode, 0)
            diagnostics = json.loads(result.stdout)["diagnostics"]
            self.assertTrue(
                any(
                    d["category"] == "lint/correctness/noUndeclaredVariables"
                    for d in diagnostics
                )
            )

    def test_every_previously_ignored_source_root_is_checked_and_formatted(self):
        with tempfile.TemporaryDirectory(prefix="carbon-biome-fixture-") as directory:
            paths = []
            for relative in (
                "scripts/source.ts",
                ".fork/tests/source.test.ts",
                "apps/erp/test/source.test.ts",
                "apps/erp/app/routes/api+/mcp+/lib/server.ts",
            ):
                path = Path(directory) / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("export const fixture={value:1}\n")
                paths.append(str(path))
            before = ci.biome(ROOT, paths, expanded=True)
            self.assertNotEqual(before.returncode, 0)
            report = json.loads(before.stdout)
            self.assertEqual(report["summary"]["unchanged"], len(paths))
            self.assertTrue(
                all(item["category"] == "format" for item in report["diagnostics"])
            )
            ci.require_biome_result(
                ci.biome(ROOT, paths, expanded=True, write=True), paths
            )
            ci.require_biome_result(ci.biome(ROOT, paths, expanded=True), paths)
            for path in paths:
                self.assertEqual(
                    Path(path).read_text(), "export const fixture = { value: 1 };\n"
                )
            self.assertFalse((ROOT / ".fork/biome.json").exists())


if __name__ == "__main__":
    unittest.main()
