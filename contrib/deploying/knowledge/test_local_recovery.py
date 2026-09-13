"""Pure contract tests for the combined database/object recovery verifier."""

import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("verify-local-recovery.py")
SPEC = importlib.util.spec_from_file_location("verify_local_recovery", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RecoveryOwnershipTests(unittest.TestCase):
    project = "knowledge-owned-recovery-test"

    def source_info(self, service):
        return {
            "Config": {"Labels": {
                "knowledge.disposable": "true",
                "knowledge.stack": "manual-local",
                "com.docker.compose.project": self.project,
                "com.docker.compose.service": service,
            }},
            "Args": ["-filesystem-root", "/data"],
            "Mounts": [{"Type": "volume", "Destination": "/data",
                        "Name": f"{self.project}_knowledge_storage"}],
        }

    def execute_preflight(self, storage=None, volume_project=None):
        calls = []

        def compose(*arguments, capture=False):
            calls.append(arguments)
            if arguments[:1] == ("ps",):
                if "--services" in arguments:
                    return "postgres\nstorage"
                return arguments[-1]
            return ""

        volume = {"Labels": {
            "com.docker.compose.project": volume_project or self.project,
            "com.docker.compose.volume": "knowledge_storage",
        }}
        with patch.dict(os.environ, {"KNOWLEDGE_LOCAL_STACK": self.project}), \
             patch("sys.argv", [str(MODULE_PATH), "--synthetic", "--disposable"]), \
             patch.object(MODULE, "compose", side_effect=compose), \
             patch.object(MODULE, "inspect", side_effect=lambda name: (
                 storage if name == "storage" and storage is not None
                 else self.source_info(name)
             )), \
             patch.object(MODULE, "run", return_value=json.dumps([volume])) as run, \
             patch.object(MODULE, "wait_postgres", side_effect=RuntimeError("preflight complete")):
            try:
                MODULE.main()
            finally:
                self.calls = calls
                self.run_calls = run.call_args_list

    def test_named_stack_uses_its_own_storage_volume(self):
        with self.assertRaisesRegex(RuntimeError, "preflight complete"):
            self.execute_preflight()
        inspected = [call.args[0] for call in self.run_calls]
        self.assertIn(["docker", "volume", "inspect",
                       f"{self.project}_knowledge_storage"], inspected)
        self.assertFalse(any("knowledge-manual-local_knowledge_storage" in call
                             for call in inspected))

    def test_other_project_container_is_rejected_before_starting_services(self):
        storage = self.source_info("storage")
        storage["Config"]["Labels"]["com.docker.compose.project"] = "another-stack"
        with self.assertRaisesRegex(ValueError, "project"):
            self.execute_preflight(storage=storage)
        self.assertTrue(all(call[0] == "ps" for call in self.calls))

    def test_foreign_or_bind_storage_mount_is_rejected_before_start(self):
        for mount in (
            {"Type": "volume", "Destination": "/data", "Name": "another-stack_knowledge_storage"},
            {"Type": "bind", "Destination": "/data", "Source": "/tmp/other-stack"},
        ):
            with self.subTest(mount=mount):
                storage = self.source_info("storage")
                storage["Mounts"] = [mount]
                with self.assertRaisesRegex(ValueError, "mount"):
                    self.execute_preflight(storage=storage)
                self.assertTrue(all(call[0] == "ps" for call in self.calls))

    def test_foreign_volume_label_is_rejected_before_start(self):
        with self.assertRaisesRegex(ValueError, "owned"):
            self.execute_preflight(volume_project="another-stack")
        self.assertTrue(all(call[0] == "ps" for call in self.calls))

    def test_compose_project_cannot_be_overridden_by_ambient_compose_project(self):
        with patch.dict(os.environ, {"KNOWLEDGE_LOCAL_STACK": self.project,
                                     "COMPOSE_PROJECT_NAME": "another-stack"}), \
             patch.object(MODULE, "run", return_value="") as run:
            MODULE.compose("ps", capture=True)
        command = run.call_args.args[0]
        self.assertIn("--project-name", command)
        self.assertEqual(command[command.index("--project-name") + 1], self.project)


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
