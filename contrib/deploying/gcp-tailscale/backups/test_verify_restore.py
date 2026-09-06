"""Guard the restore verifier's source validation and destructive cleanup boundary."""

import io
import unittest
from unittest.mock import Mock

import verify_restore


CONFIG = {"PROJECT_ID": "example-project", "REGION": "us-east1", "ZONE": "us-east1-b", "VM_NAME": "example"}
SOURCE = "https://www.googleapis.com/compute/v1/projects/example-project/zones/us-east1-b/disks/example-data"


class RestoreSafetyTests(unittest.TestCase):
    def test_only_ready_snapshot_of_configured_source_is_accepted(self):
        verify_restore.validate_snapshot(CONFIG, {"status": "READY", "sourceDisk": SOURCE})
        for bad in (
            {"status": "CREATING", "sourceDisk": SOURCE},
            {"status": "READY", "sourceDisk": SOURCE.replace("example-project", "other-project")},
            {"status": "READY", "sourceDisk": SOURCE.replace("us-east1-b", "us-east1-c")},
            {"status": "READY", "sourceDisk": SOURCE + "-other"},
        ):
            with self.subTest(snapshot=bad), self.assertRaises(ValueError):
                verify_restore.validate_snapshot(CONFIG, bad)

    def test_bad_snapshot_stops_before_resource_creation(self):
        check = verify_restore.RestoreCheck(CONFIG, io.StringIO())
        check.get = Mock(return_value={"status": "READY", "sourceDisk": SOURCE + "-other"})
        check.call = Mock()
        with self.assertRaises(ValueError):
            check.execute("example-snapshot")
        check.call.assert_not_called()

    def test_cleanup_refuses_unowned_resources(self):
        check = verify_restore.RestoreCheck(CONFIG, io.StringIO())
        check.get = Mock(return_value=[{"labels": {"managed-by": "another-tool"}}])
        check.call = Mock()
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            check.cleanup()
        check.call.assert_not_called()

    def test_cleanup_requires_exact_run_label(self):
        check = verify_restore.RestoreCheck(CONFIG, io.StringIO())
        check.get = Mock(return_value=[{"labels": {**check.labels, "restore-run": "another-run"}}])
        check.call = Mock()
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            check.cleanup()
        check.call.assert_not_called()

    def test_cleanup_only_deletes_owned_temporary_resources(self):
        check = verify_restore.RestoreCheck(CONFIG, io.StringIO())
        check.get = Mock(side_effect=[[{"labels": check.labels}], [{"labels": check.labels}], [], []])
        check.call = Mock()
        check.cleanup()
        self.assertEqual(check.call.call_args_list[0].args,
            ("compute", "instances", "delete", check.vm, "--zone", CONFIG["ZONE"]))
        self.assertEqual(check.call.call_args_list[1].args,
            ("compute", "disks", "delete", check.disk, "--zone", CONFIG["ZONE"]))
        self.assertNotEqual(check.disk, CONFIG["VM_NAME"] + "-data")

    def test_resource_names_cannot_inject_flags_or_paths(self):
        for name in ("--quiet", "other/snapshot", "snapshot;echo", "name\nvalue"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                verify_restore.validate(CONFIG, name)


if __name__ == "__main__":
    unittest.main()
