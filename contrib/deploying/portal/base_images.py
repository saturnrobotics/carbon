"""Reviewed immutable base images for every portal OCI unit.

`base-images.json` is the single record. Each `Dockerfile.*` repeats the value as
its `ARG` default so a plain `docker build` needs no extra flags, and the checks
here fail when a Dockerfile drifts from the record or names a floating tag.
"""

from __future__ import annotations

import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
PINS_PATH = HERE / "base-images.json"
PINNED_IMAGE = re.compile(r"^[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$")
ARG_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
FROM_LINE = re.compile(r"^FROM\s+(?:--platform=\S+\s+)?(?P<image>\S+)(?:\s+AS\s+(?P<stage>\S+))?\s*$", re.I)
ARG_LINE = re.compile(r"^ARG\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?:=(?P<value>\S*))?\s*$")


def load_pins(path: Path = PINS_PATH) -> dict[str, str]:
    """Read the reviewed record; every entry must be a digest-pinned tag."""
    document = json.loads(path.read_text())
    if not isinstance(document, dict) or not document:
        raise ValueError(f"{path.name} must map build-argument names to pinned images")
    for name, value in document.items():
        if not ARG_NAME.fullmatch(name) or not isinstance(value, str) or not PINNED_IMAGE.fullmatch(value):
            raise ValueError(f"{path.name}: {name} must pin a tag to a reviewed sha256 digest")
    return dict(document)


def dockerfile_paths(directory: Path = HERE) -> list[Path]:
    return sorted(path for path in directory.glob("Dockerfile.*") if path.is_file())


def check_dockerfile(text: str, pins: dict[str, str]) -> list[str]:
    """Return the stage names; raise when a base image is floating or drifts from the record."""
    declared: dict[str, str | None] = {}
    stages: list[str] = []
    seen_from = False
    for raw in text.splitlines():
        line = raw.strip()
        argument = ARG_LINE.match(line)
        if argument and not seen_from:
            declared[argument["name"]] = argument["value"]
            continue
        base = FROM_LINE.match(line)
        if not base:
            continue
        seen_from = True
        image = base["image"]
        if image.startswith("${") and image.endswith("}"):
            name = image[2:-1]
            if name not in pins:
                raise ValueError(f"FROM {image} is not a reviewed base image")
            if declared.get(name) != pins[name]:
                raise ValueError(f"ARG {name} must default to the reviewed pin {pins[name]}")
        elif image not in stages:
            raise ValueError(f"FROM {image} is a floating or unreviewed base image")
        if base["stage"]:
            stages.append(base["stage"])
    if not seen_from:
        raise ValueError("Dockerfile declares no stage")
    for name in set(declared) & set(pins):
        if declared[name] != pins[name]:
            raise ValueError(f"ARG {name} must default to the reviewed pin {pins[name]}")
    return stages


def check_all(directory: Path = HERE, pins: dict[str, str] | None = None) -> dict[str, list[str]]:
    pins = load_pins() if pins is None else pins
    result = {}
    for path in dockerfile_paths(directory):
        try:
            result[path.name] = check_dockerfile(path.read_text(), pins)
        except ValueError as error:
            raise ValueError(f"{path.name}: {error}") from None
    if not result:
        raise ValueError("No portal Dockerfiles found")
    return result


if __name__ == "__main__":
    for name, stages in check_all().items():
        print(name, ", ".join(stages) or "(single stage)")
