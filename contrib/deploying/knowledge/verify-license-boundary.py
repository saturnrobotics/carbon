#!/usr/bin/env python3
"""Prove the knowledge images stay outside the enterprise license boundary.

Carbon's LICENSE reserves commercial terms for `packages/ee` and files with `.ee`
in their names (docs/public-fork.md, "Source availability and licenses"). Every
knowledge image is a pruned workspace closure, so the static check walks the
closure each Dockerfile prunes and refuses the enterprise package or any `.ee.`
file inside it, and requires the shipped stages to copy LICENSE (and NOTICE when
one exists) so the license accompanies the code. `--image` inspects a built image
the same way `verify-build-context.py` inspects a context: through the actual
Docker output, here `docker export`, without running the image.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile

import base_images

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
ENTERPRISE_PACKAGE = "@carbon/ee"
ENTERPRISE_DIRECTORY = "packages/ee"
ENTERPRISE_FILE = re.compile(r"\.ee\.")
LICENSE_FILES = ("LICENSE", "NOTICE")
SHIPPED_STAGES = ("runtime", "e2e")
SKIPPED_DIRECTORIES = {"node_modules", "dist", "build", ".turbo", ".react-router", "e2e-dist"}
PRUNE_LINE = re.compile(r"turbo@\S+\s+prune\s+(?P<targets>(?:[^-\s]\S*\s+)+)--docker")
BUILD_DEPENDENCY_FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
# `pnpm deploy --prod` ships only these edges; the builder stage keeps every edge.
PRODUCTION_DEPENDENCY_FIELDS = ("dependencies", "optionalDependencies")


class LicenseBoundaryViolation(ValueError):
    pass


def required_license_files(root: Path = ROOT) -> list[str]:
    present = [name for name in LICENSE_FILES if (root / name).is_file()]
    if "LICENSE" not in present:
        raise LicenseBoundaryViolation("Repository LICENSE is missing")
    return present


def workspace_packages(root: Path) -> dict[str, Path]:
    """Map workspace package names to directories from pnpm-workspace.yaml globs."""
    globs = []
    in_packages = False
    for raw in (root / "pnpm-workspace.yaml").read_text().splitlines():
        line = raw.rstrip()
        if line == "packages:":
            in_packages = True
            continue
        if in_packages and line.startswith("  - "):
            globs.append(line[4:].strip().strip("'\""))
            continue
        if in_packages and line and not line.startswith(" "):
            in_packages = False
    packages: dict[str, Path] = {}
    for pattern in globs:
        for manifest in sorted(root.glob(pattern + "/package.json")):
            if "node_modules" in manifest.parts:
                continue
            name = json.loads(manifest.read_text()).get("name")
            if isinstance(name, str):
                packages[name] = manifest.parent
    return packages


def workspace_closure(
    root: Path, targets: list[str], packages: dict[str, Path] | None = None, *, production: bool = False
) -> dict[str, Path]:
    """Workspace packages reachable from `targets`: every edge for the build closure, runtime edges when `production`."""
    packages = workspace_packages(root) if packages is None else packages
    fields = PRODUCTION_DEPENDENCY_FIELDS if production else BUILD_DEPENDENCY_FIELDS
    closure: dict[str, Path] = {}
    pending = list(targets)
    while pending:
        name = pending.pop()
        if name in closure:
            continue
        if name not in packages:
            raise LicenseBoundaryViolation(f"Unknown workspace package {name}")
        closure[name] = packages[name]
        manifest = json.loads((packages[name] / "package.json").read_text())
        for field in fields:
            for dependency, version in manifest.get(field, {}).items():
                if isinstance(version, str) and version.startswith("workspace:") and dependency in packages:
                    pending.append(dependency)
    return closure


def prune_targets(dockerfile: str) -> list[str]:
    targets: list[str] = []
    for match in PRUNE_LINE.finditer(dockerfile):
        targets.extend(match["targets"].split())
    return targets


def enterprise_files(directories: list[Path]) -> list[Path]:
    found = []
    for directory in directories:
        for path in sorted(directory.rglob("*")):
            if any(part in SKIPPED_DIRECTORIES for part in path.relative_to(directory).parts[:-1]):
                continue
            if path.is_file() and ENTERPRISE_FILE.search(path.name):
                found.append(path)
    return found


def stage_license_coverage(dockerfile: str, required: list[str]) -> dict[str, set[str]]:
    """License files each stage carries: copied in the stage or inherited from a parent stage."""
    coverage: dict[str, set[str]] = {}
    current = None
    for raw in dockerfile.splitlines():
        line = raw.strip()
        base = base_images.FROM_LINE.match(line)
        if base:
            current = base["stage"] or ""
            coverage[current] = set(coverage.get(base["image"], set()))
            continue
        if current is None:
            continue
        copy = re.match(r"^COPY\s+(?!--from)(?P<source>\S+)\s+\S+", line)
        if copy and copy["source"] in required:
            coverage[current].add(copy["source"])
    return coverage


def check_dockerfile(root: Path, path: Path, packages: dict[str, Path] | None = None) -> dict[str, list[str]]:
    dockerfile = path.read_text()
    required = required_license_files(root)
    targets = prune_targets(dockerfile)
    build_closure = workspace_closure(root, targets, packages) if targets else {}
    enterprise = sorted(
        name for name, directory in build_closure.items()
        if name == ENTERPRISE_PACKAGE or directory.resolve() == (root / ENTERPRISE_DIRECTORY).resolve()
    )
    if enterprise:
        raise LicenseBoundaryViolation(f"{path.name} build closure includes the enterprise package: {', '.join(enterprise)}")
    closure = workspace_closure(root, targets, packages, production=True) if targets else {}
    tainted = enterprise_files(list(closure.values()))
    if tainted:
        shown = ", ".join(str(item.relative_to(root)) for item in tainted[:5])
        raise LicenseBoundaryViolation(f"{path.name} runtime closure includes {len(tainted)} enterprise-licensed files: {shown}")
    coverage = stage_license_coverage(dockerfile, required)
    shipped = [stage for stage in coverage if stage in SHIPPED_STAGES]
    if not shipped and "" in coverage:
        shipped = [""]
    if not shipped:
        raise LicenseBoundaryViolation(f"{path.name} has no shipped stage ({', '.join(SHIPPED_STAGES)})")
    for stage in shipped:
        missing = sorted(set(required) - coverage[stage])
        if missing:
            label = stage or "the image"
            raise LicenseBoundaryViolation(f"{path.name} stage {label} does not copy {', '.join(missing)}")
    return {"targets": targets, "closure": sorted(closure), "shipped": shipped}


def check_image_entries(entries: list[str], working_dir: str, required: list[str]) -> None:
    """`entries` are tar member names from `docker export`; enterprise content anywhere is a leak."""
    leaks = []
    for entry in entries:
        normalized = "/" + entry.lstrip("./")
        parts = PurePosixPath(normalized).parts
        if f"/{ENTERPRISE_DIRECTORY}/" in normalized or f"/{ENTERPRISE_PACKAGE}/" in normalized:
            leaks.append(normalized)
        elif "node_modules" not in parts and ENTERPRISE_FILE.search(parts[-1]):
            leaks.append(normalized)
    if leaks:
        raise LicenseBoundaryViolation(f"image contains {len(leaks)} enterprise-licensed paths: {', '.join(leaks[:5])}")
    present = {"/" + entry.lstrip("./") for entry in entries}
    directory = PurePosixPath(working_dir or "/")
    candidates = [directory, *directory.parents]
    for name in required:
        if not any(str(candidate / name) in present for candidate in candidates):
            raise LicenseBoundaryViolation(f"image working directory {directory} and its parents carry no {name}")


def image_entries(reference: str) -> tuple[list[str], str]:
    inspect = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Config.WorkingDir}}", reference],
        text=True, capture_output=True, check=True,
    )
    container = subprocess.run(
        ["docker", "create", "--entrypoint", "/bin/true", reference], text=True, capture_output=True, check=True
    ).stdout.strip()
    try:
        with tempfile.TemporaryDirectory(prefix="knowledge-license-") as temporary:
            archive = Path(temporary) / "image.tar"
            with archive.open("wb") as stream:
                subprocess.run(["docker", "export", container], stdout=stream, check=True)
            with tarfile.open(archive) as tar:
                entries = tar.getnames()
    finally:
        subprocess.run(["docker", "rm", "-f", container], capture_output=True, check=False)
    return entries, inspect.stdout.strip()


def check_image(reference: str, root: Path = ROOT) -> int:
    entries, working_dir = image_entries(reference)
    check_image_entries(entries, working_dir, required_license_files(root))
    return len(entries)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--image", action="append", default=[], help="built image reference to inspect (repeatable)")
    parser.add_argument("--dockerfile", type=Path, action="append", help="restrict the static check to these Dockerfiles")
    arguments = parser.parse_args()
    dockerfiles = arguments.dockerfile or base_images.dockerfile_paths()
    packages = workspace_packages(ROOT)
    for path in dockerfiles:
        result = check_dockerfile(ROOT, path, packages)
        print(f"{path.name}: {len(result['closure'])} workspace packages, license in {', '.join(s or 'image' for s in result['shipped'])}")
    for reference in arguments.image:
        if not fnmatch.fnmatch(reference, "*:*") and "@sha256:" not in reference:
            raise LicenseBoundaryViolation(f"{reference} must name a tag or digest, not a floating repository")
        count = check_image(reference)
        print(f"{reference}: {count} entries, no enterprise content, license present")
    print("License boundary proof passed")


if __name__ == "__main__":
    main()
