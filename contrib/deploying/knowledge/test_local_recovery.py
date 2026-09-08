"""Pure contract tests for the combined database/object recovery verifier."""

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("verify-local-recovery.py")
SPEC = importlib.util.spec_from_file_location("verify_local_recovery", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RecoveryComparisonTests(unittest.TestCase):
    def test_storage_configuration_rejects_seed_reimport(self):
        valid = {"Args": ["-scheme", "http", "-filesystem-root", "/data"]}
        MODULE.assert_storage_configuration(valid)
        with self.assertRaises(ValueError):
            MODULE.assert_storage_configuration({
                "Args": ["-data", "/data", "-filesystem-root", "/data"]
            })
        with self.assertRaises(ValueError):
            MODULE.assert_storage_configuration({"Args": ["-scheme", "http"]})

    def test_exact_object_inventory_requires_generation_size_and_hash(self):
        expected = {
            "input/manual.pdf": {
                "generation": "7",
                "size": 42,
                "sha256": "a" * 64,
                "contentType": "application/pdf",
            }
        }
        MODULE.assert_exact_inventory(expected, expected.copy())
        for field, value in (
            ("generation", "8"),
            ("size", 43),
            ("sha256", "b" * 64),
            ("contentType", "application/octet-stream"),
        ):
            changed = {key: item.copy() for key, item in expected.items()}
            changed["input/manual.pdf"][field] = value
            with self.subTest(field=field), self.assertRaises(AssertionError):
                MODULE.assert_exact_inventory(expected, changed)
        with self.assertRaises(AssertionError):
            MODULE.assert_exact_inventory(expected, {})

    def test_database_proof_requires_acl_tombstones_and_object_references(self):
        proof = {
            "aliceVisible": ["doc-a"],
            "bobVisible": ["doc-b"],
            "tombstones": ["doc-deleted"],
            "objectReferences": 2,
            "lexicalMatches": ["doc-b"],
        }
        MODULE.assert_database_proof(proof)
        for field, value in (
            ("aliceVisible", []),
            ("bobVisible", []),
            ("tombstones", []),
            ("objectReferences", 0),
            ("lexicalMatches", []),
        ):
            invalid = {**proof, field: value}
            with self.subTest(field=field), self.assertRaises(AssertionError):
                MODULE.assert_database_proof(invalid)


if __name__ == "__main__":
    unittest.main()
