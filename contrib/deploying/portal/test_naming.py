"""Regression checks for platform names and immutable migration evidence."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class NamingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("portal_naming", HERE / "verify-naming.py")
        cls.guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.guard)

    def scan(self, files, history=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            return self.guard.check(root, files, history or {"files": {}, "compatibility": []})

    def test_runtime_env_package_and_cloud_regressions_are_rejected(self):
        for content in ('env.KNOWLEDGE_QUERY_URL', '"@carbon/knowledge"', 'name = "knowledge-web"'):
            with self.subTest(content=content):
                self.assertTrue(self.scan({"apps/portal/src/runtime.ts": content}))

    def test_new_old_named_paths_are_rejected(self):
        self.assertTrue(self.scan({"apps/knowledge-worker/src/runtime.ts": "export {};"}))

    def test_cross_tree_glue_is_scanned(self):
        self.assertTrue(self.scan({"scripts/new-release.sh": "pnpm --filter @carbon/knowledge build"}))

    def test_generic_upstream_agent_knowledge_remains_valid(self):
        self.assertFalse(self.scan({"apps/erp/app/agent/knowledge.ts": "// Search the knowledge base for guidance."}))

    def test_acknowledgement_is_not_a_product_identifier(self):
        self.assertFalse(self.scan({"packages/portal/src/events.ts": "acknowledge(); // unacknowledged Acknowledgement"}))

    def test_historical_filename_reference_is_allowed(self):
        path = "packages/portal/migrations/20260908000245_knowledge-foundation.sql"
        history = {"files": {path: self.guard.digest(b"SELECT 1;")}, "compatibility": []}
        files = {path: "SELECT 1;", "packages/portal/scripts/check.py": "name = '20260908000245_knowledge-foundation.sql'"}
        self.assertFalse(self.scan(files, history))
        files["packages/portal/scripts/check.py"] = "name = '20990101000000_knowledge-new.sql'"
        self.assertTrue(self.scan(files, history))

    def test_history_bytes_are_checked_even_without_a_legacy_token(self):
        content = "SELECT 1;\n"
        path = "packages/portal/migrations/20260908000245_knowledge-foundation.sql"
        history = {"files": {path: self.guard.digest(content.encode())}, "compatibility": []}
        self.assertFalse(self.scan({path: content}, history))
        self.assertTrue(self.scan({path: "SELECT 2;\n"}, history))
        self.assertTrue(self.scan({}, history))

    def test_compatibility_is_exact_path_only(self):
        path = "packages/portal/scripts/legacy-bridge.ts"
        history = {"files": {}, "compatibility": [path]}
        self.assertFalse(self.scan({path: "knowledge_migrations.ledger"}, history))
        self.assertTrue(self.scan({path + ".new": "knowledge_migrations.ledger"}, history))

    def test_repository_passes(self):
        root = HERE.parents[2]
        history = json.loads((HERE / "naming-history.json").read_text())
        self.assertEqual(self.guard.check(root, self.guard.source_files(root), history), [])
