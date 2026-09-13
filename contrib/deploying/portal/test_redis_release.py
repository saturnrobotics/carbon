"""The managed Redis trust bundle must reach only its client and survive rotation."""
import copy
import unittest

import release
from test_deploy import module
from test_deploy_preflight import configuration
from test_release import database_plan, foundation_outputs, plan


class RedisCertificateReleaseTests(unittest.TestCase):
    def test_query_mounts_both_ca_bundles_and_rotates_revision(self):
        candidate = database_plan("portal-query")
        unit = candidate["services"]["portal-query"]
        unit["database_ca_secret"] = "projects/example/secrets/portal-source-database-ca/versions/1"
        unit["redis_ca_secret"] = "projects/example/secrets/portal-redis-ca/versions/2"
        release.validate_plan(candidate)
        digest = release.revision_digest(unit)
        runtime = release.revision_document("portal-query", unit, digest)["spec"]["template"]["spec"]
        self.assertEqual({v["name"] for v in runtime["volumes"]}, {"database-ca", "redis-ca"})
        self.assertIn({"name": "redis-ca", "mountPath": "/var/run/secrets/portal-redis-ca"}, runtime["containers"][0]["volumeMounts"])
        self.assertIn({"name": "PORTAL_REDIS_TLS_CA_FILE", "value": "/var/run/secrets/portal-redis-ca/ca.pem"}, runtime["containers"][0]["env"])
        unit["redis_ca_secret"] = "projects/example/secrets/portal-redis-ca/versions/3"
        self.assertNotEqual(digest, release.revision_digest(unit))

    def test_refuses_unpinned_ca_and_non_cache_recipients(self):
        candidate = database_plan("portal-query")
        candidate["services"]["portal-query"]["redis_ca_secret"] = "projects/example/secrets/portal-redis-ca/versions/latest"
        with self.assertRaisesRegex(ValueError, "pinned Redis CA"):
            release.validate_plan(candidate)
        for name in release.UNITS.keys() - {"portal-query"}:
            candidate = plan() if name == "portal-web" else database_plan(name)
            candidate["services"][name]["redis_ca_secret"] = "projects/example/secrets/portal-redis-ca/versions/2"
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "cannot receive a Redis CA"):
                release.validate_plan(candidate)

    def test_configuration_forwards_pinned_target_ca_only_to_query(self):
        deploy = module()
        config = configuration(deploy)
        config["redis_ca_secret"] = "projects/example-project/secrets/portal-redis-ca/versions/2"
        deploy.validate_config(config)
        candidate = deploy.prepare_plan(config, "a" * 40, foundation_outputs(), ["20260913192023_portal-private-identifiers"])
        self.assertEqual(candidate["services"]["portal-query"]["redis_ca_secret"], config["redis_ca_secret"])
        self.assertTrue(all("redis_ca_secret" not in unit for name, unit in candidate["services"].items() if name != "portal-query"))
        bad = copy.deepcopy(config)
        bad["redis_ca_secret"] = "projects/other-project/secrets/portal-redis-ca/versions/2"
        with self.assertRaisesRegex(ValueError, "Redis CA"):
            deploy.validate_config(bad)


if __name__ == "__main__":
    unittest.main()
