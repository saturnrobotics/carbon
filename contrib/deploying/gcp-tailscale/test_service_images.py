"""service_images.py: patched platform images, never below upstream's own pins."""

import unittest

import service_images as module


def services(**images):
    return {name: {"image": images.get(name, image)} for name, image in {
        "postgres": "supabase/postgres:15.14.1.112", "realtime": "supabase/realtime:v2.89.0",
        "edge-runtime": "supabase/edge-runtime:v1.74.0", "redis": "redis:7-alpine", "caddy": "caddy:2-alpine",
    }.items()}


class ServiceImageTests(unittest.TestCase):
    def test_upstream_pins_are_raised_to_the_patched_releases(self):
        stack = services()
        module.configure(stack)
        self.assertEqual({name: service["image"] for name, service in stack.items()}, module.IMAGES)

    def test_newer_upstream_releases_are_kept(self):
        newer = {"postgres": "supabase/postgres:15.20.0.001", "realtime": "supabase/realtime:v2.150.0",
                 "edge-runtime": "supabase/edge-runtime:v1.78.0", "redis": "redis:8-alpine", "caddy": "caddy:2.12.0-alpine"}
        stack = services(**newer)
        module.configure(stack)
        self.assertEqual({name: service["image"] for name, service in stack.items()}, newer)

    def test_the_same_release_or_a_digest_reference_is_not_rewritten_backwards(self):
        stack = services(realtime="supabase/realtime:v2.147.1@sha256:" + "a" * 64)
        module.configure(stack)
        self.assertEqual(stack["realtime"]["image"], module.IMAGES["realtime"])
        self.assertEqual(module.parse("supabase/realtime:v2.147.1@sha256:" + "a" * 64), ("supabase/realtime", (2, 147, 1)))

    def test_floating_tags_are_pinned(self):
        self.assertEqual(module.parse("redis:7-alpine"), ("redis", (7,)))
        stack = services()
        module.configure(stack)
        self.assertEqual(stack["redis"]["image"], "redis:7.4.11-alpine")
        self.assertEqual(stack["caddy"]["image"], "caddy:2.11.7-alpine")

    def test_unexpected_repositories_and_tags_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "valkey/valkey, not redis"):
            module.configure(services(redis="valkey/valkey:8-alpine"))
        for image in ("supabase/postgres:latest", "supabase/postgres", "", None):
            with self.subTest(image=image), self.assertRaisesRegex(ValueError, "review service_images.py"):
                module.configure(services(postgres=image))

    def test_postgres_floor_matches_the_pinned_release(self):
        _, version = module.parse(module.IMAGES["postgres"])
        self.assertEqual(module.POSTGRES_PATCHED, version[0] * 10000 + version[1])


if __name__ == "__main__":
    unittest.main()
