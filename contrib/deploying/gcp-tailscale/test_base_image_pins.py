"""The deploy planner must use reviewed base images without consulting mutable tags."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare_release


class ReviewedBaseImageTests(unittest.TestCase):
    def test_pinned_docker_defaults_are_used_offline(self):
        pins = {
            "NODE_IMAGE": "node:22@sha256:" + "a" * 64,
            "NODE_SLIM_IMAGE": "node:22-slim@sha256:" + "b" * 64,
        }
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / "Dockerfile").write_text(
                "\n".join(f"ARG {key}={value}" for key, value in pins.items())
            )
            with patch(
                "prepare_release.subprocess.run",
                side_effect=AssertionError("Registry access is forbidden"),
            ):
                try:
                    actual = prepare_release.resolve_base_images(repo)
                except ValueError as error:
                    self.fail(f"Reviewed immutable defaults were rejected: {error}")
                self.assertEqual(actual, pins)

    def test_mutable_or_unexpected_base_images_fail_closed(self):
        for value in (
            "node:22",
            "node:22@sha256:short",
            "example.com/node@sha256:" + "a" * 64,
        ):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                repo = Path(directory)
                (repo / "Dockerfile").write_text(
                    f"ARG NODE_IMAGE={value}\nARG NODE_SLIM_IMAGE=node:22-slim@sha256:"
                    + "b" * 64
                )
                with patch(
                    "prepare_release.subprocess.run",
                    side_effect=AssertionError("Registry access is forbidden"),
                ):
                    with self.assertRaises(ValueError):
                        prepare_release.resolve_base_images(repo)

    def test_repository_defaults_are_immutable(self):
        repo = Path(__file__).resolve().parents[3]
        declarations = (repo / "Dockerfile").read_text().splitlines()
        for key, tag in prepare_release.BASE_DEFAULTS.items():
            declaration = next(
                line for line in declarations if line.startswith(f"ARG {key}=")
            )
            self.assertRegex(declaration, f"^ARG {key}={tag}@sha256:[a-f0-9]{{64}}$")


if __name__ == "__main__":
    unittest.main()
