"""Every portal image must build from the reviewed digest record, never a floating tag."""

from pathlib import Path
import re
import unittest

import base_images

HERE = Path(__file__).resolve().parent
DIGEST = "sha256:" + "a" * 64


class ReviewedBaseImageTests(unittest.TestCase):
    def test_record_pins_every_entry_to_a_digest(self):
        pins = base_images.load_pins()
        self.assertEqual(set(pins), {"NODE_IMAGE"})
        self.assertRegex(pins["NODE_IMAGE"], r"^node:22-alpine@sha256:[a-f0-9]{64}$")

    def test_every_portal_dockerfile_matches_the_record(self):
        stages = base_images.check_all()
        self.assertEqual(
            set(stages),
            {f"Dockerfile.{unit}" for unit in ("actions", "ingest", "parser", "probe", "query", "retention", "schema", "web")},
        )
        for path in base_images.dockerfile_paths():
            with self.subTest(dockerfile=path.name):
                text = path.read_text()
                self.assertNotIn("FROM node:", text)
                self.assertEqual(len(re.findall(r"^ARG NODE_IMAGE=", text, re.M)), 1)

    def test_floating_tags_and_record_drift_fail(self):
        pins = {"NODE_IMAGE": "node:22-alpine@" + DIGEST}
        good = f"ARG NODE_IMAGE={pins['NODE_IMAGE']}\nFROM ${{NODE_IMAGE}} AS builder\nFROM builder AS runtime\n"
        self.assertEqual(base_images.check_dockerfile(good, pins), ["builder", "runtime"])
        for text, reason in (
            ("FROM node:22-alpine AS builder\n", "floating"),
            (f"ARG NODE_IMAGE={pins['NODE_IMAGE']}\nFROM node:22-alpine@{DIGEST}\n", "floating or unreviewed"),
            ("ARG NODE_IMAGE=node:22-alpine\nFROM ${NODE_IMAGE}\n", "reviewed pin"),
            (f"ARG NODE_IMAGE=node:22-alpine@sha256:{'b' * 64}\nFROM ${{NODE_IMAGE}}\n", "reviewed pin"),
            ("ARG OTHER_IMAGE=node:22-alpine@" + DIGEST + "\nFROM ${OTHER_IMAGE}\n", "not a reviewed"),
            (f"ARG NODE_IMAGE={pins['NODE_IMAGE']}\nFROM ${{NODE_IMAGE}} AS builder\nFROM unknown AS runtime\n", "floating"),
            ("RUN true\n", "no stage"),
        ):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, reason):
                base_images.check_dockerfile(text, pins)

    def test_record_rejects_mutable_or_malformed_entries(self):
        for value in ("node:22-alpine", "node:22-alpine@sha256:short", "", 7):
            with self.subTest(value=value), self.assertRaises(ValueError):
                base_images.load_pins(_temporary_record({"NODE_IMAGE": value}))

    def test_build_entrypoints_never_override_the_pin(self):
        for name in ("build-images.sh", "cloudbuild.yaml", "compose.local.yaml", "local-stack.sh"):
            with self.subTest(file=name):
                self.assertNotIn("NODE_IMAGE", (HERE / name).read_text())


def _temporary_record(document):
    import json
    import tempfile

    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(document, handle)
    handle.close()
    return Path(handle.name)


if __name__ == "__main__":
    unittest.main()
