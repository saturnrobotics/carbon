import importlib.util
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "knowledge_recovery", HERE / "verify_recovery.py"
)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoverySafetyTests(unittest.TestCase):
    def test_accepts_only_labelled_loopback_nonstandard_postgres(self):
        fixture = {
            "Config": {"Labels": {"knowledge.disposable": "true"}},
            "NetworkSettings": {
                "Ports": {
                    "5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "59910"}]
                }
            },
        }
        self.assertEqual(recovery.validate_container_info(fixture), "59910")
        fixture["Config"]["Labels"] = {}
        with self.assertRaisesRegex(ValueError, "labelled disposable"):
            recovery.validate_container_info(fixture)

    def test_rejects_default_or_nonloopback_database_ports(self):
        fixture = {
            "Config": {"Labels": {"knowledge.disposable": "true"}},
            "NetworkSettings": {
                "Ports": {
                    "5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5432"}]
                }
            },
        }
        with self.assertRaisesRegex(ValueError, "loopback"):
            recovery.validate_container_info(fixture)


if __name__ == "__main__":
    unittest.main()
