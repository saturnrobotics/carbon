"""After installation, exercise real Biome project discovery and safe autofixes."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("fork_ci", ROOT / ".fork/ci.py")
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


class BiomeLiveTests(unittest.TestCase):
    def test_every_previously_ignored_source_root_is_checked_and_formatted(self):
        with tempfile.TemporaryDirectory(prefix="carbon-biome-fixture-") as directory:
            paths = []
            for relative in (
                "scripts/source.ts",
                ".fork/tests/source.test.ts",
                "apps/erp/test/source.test.ts",
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
