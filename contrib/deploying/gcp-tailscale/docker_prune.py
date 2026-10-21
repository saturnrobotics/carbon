"""Bound Docker's share of the data disk without breaking rollback.

Docker's data-root is /var/lib/carbon/docker, on the filesystem PostgreSQL
writes to, and every release builds its ERP, MES and ops images on the VM.

``guard`` refuses a build when the data disk has less free space than
DOCKER_BUILD_MIN_FREE_GB (default 15). ``prune`` removes Docker images and
build cache after a successful release, and on demand; ``plan`` prints the same
decision and removes nothing.

An image is kept when any of these names it:

* a container, running or stopped;
* the last DOCKER_KEEP_RELEASES (default 2) successful releases in
  runtime/release-history, and the current release manifest;
* the active or previous Compose definition in runtime/, which routine and
  maintenance rollback start from;
* a prepared Compose definition written after the last successful release,
  that is a deployment in progress or one that failed.

Every other image is removed tag by tag, never forced: Docker refuses to
delete an image with several tags by ID, and deletes it with its last tag. An
untagged image is removed by ID. A kept image loses the tags nothing names,
but only while a tag something names remains. Build cache is then cut to
DOCKER_BUILD_CACHE_KEEP_GB (default 20), least recently and least often used
first. Volumes are never touched.
"""

import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import host_release

CONFIG_KEYS = {"DOCKER_KEEP_RELEASES", "DOCKER_BUILD_MIN_FREE_GB", "DOCKER_BUILD_CACHE_KEEP_GB"}
# 2**30 bytes: the unit of df -h, of GCP disk sizes and of Docker's size flags.
GB = 1 << 30
RUNTIME_COMPOSE = ("compose.json", "previous-compose.json", "routine-previous-compose.json")
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}")
COMMIT = re.compile(r"[a-f0-9]{40,64}")


def _integer(config, key, default, low, high):
    value = config.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise ValueError(f"{key} must be an integer from {low} to {high}")
    return value


def keep_releases(config):
    return _integer(config, "DOCKER_KEEP_RELEASES", 2, 1, 20)


def min_free_gb(config):
    return _integer(config, "DOCKER_BUILD_MIN_FREE_GB", 15, 1, 10000)


def build_cache_keep_gb(config):
    # What the next build reuses is the last one's ERP and MES dependency
    # installs (about 2 GB each) and the pnpm package store. Every build uses
    # them, and pruning removes the least recently and least often used cache
    # first, so they go last. 20 GB keeps them with room to spare; the rest is
    # superseded builds' source, output and ops install layers, which no later
    # build matches.
    return _integer(config, "DOCKER_BUILD_CACHE_KEEP_GB", 20, 1, 10000)


def validate(config):
    keep_releases(config)
    min_free_gb(config)
    build_cache_keep_gb(config)


def free_bytes(path):
    """Space unprivileged writers such as PostgreSQL can still use (df's Avail)."""
    stat = os.statvfs(path)
    return stat.f_bavail * stat.f_frsize


def guard(config, state):
    minimum = min_free_gb(config)
    free = free_bytes(state)
    if free < minimum * GB:
        raise ValueError(
            f"Only {free / GB:.1f} GB is free on the data disk; building needs at least {minimum} GB "
            "(DOCKER_BUILD_MIN_FREE_GB). Nothing was built or stopped. Free space with the host-deploy.sh "
            "prune action (README: Disk usage and pruning), then deploy again."
        )
    print(f"{free / GB:.1f} GB free on the data disk; at least {minimum} GB is required to build.")


def _json(path):
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        raise ValueError(f"Cannot read {path}; nothing was pruned") from None
    if not isinstance(value, dict):
        raise ValueError(f"Unexpected content in {path}; nothing was pruned")
    return value


def compose_images(path):
    """Every image a Compose definition names, profile-only services included."""
    services = _json(path).get("services", {})
    if not isinstance(services, dict):
        raise ValueError(f"Unexpected services in {path}; nothing was pruned")
    return {
        service["image"]
        for service in services.values()
        if isinstance(service, dict) and isinstance(service.get("image"), str) and service["image"]
    }


def release_images(record):
    """A release's app images by ID and tag, its ops image, and its Compose images."""
    images = record.get("images", [])
    if not isinstance(images, list) or not all(isinstance(image, str) for image in images):
        raise ValueError("Invalid image list in a release record; nothing was pruned")
    references = set(images)
    services = record.get("services", {})
    if not isinstance(services, dict):
        raise ValueError("Invalid services in a release record; nothing was pruned")
    for name, service in services.items():
        if not isinstance(service, dict) or not re.fullmatch(r"[a-z][a-z0-9-]*", name):
            raise ValueError("Invalid service in a release record; nothing was pruned")
        if IMAGE_ID.fullmatch(str(service.get("image_digest", ""))):
            references.add(service["image_digest"])
        if COMMIT.fullmatch(str(service.get("source_commit", ""))):
            references.add(f"carbon/{name}:{service['source_commit']}")
    if COMMIT.fullmatch(str(record.get("revision", ""))):
        references.add(f"carbon/ops:{record['revision']}")
    return references


def history(runtime):
    """Successful release records, newest first."""
    records = []
    for path in sorted((runtime / host_release.HISTORY).glob("*.json")):
        record = _json(path)
        generation = record.get("generation")
        if not isinstance(generation, int) or isinstance(generation, bool) or generation < 1:
            raise ValueError(f"Invalid release history record {path.name}; nothing was pruned")
        records.append(record)
    return sorted(records, key=lambda record: record["generation"], reverse=True)


def repo_tag(reference):
    """A tag reference as Docker lists it in RepoTags, or None for an ID or a digest-only reference."""
    if IMAGE_ID.fullmatch(reference):
        return None
    name, _, digest = reference.partition("@")
    if ":" not in name.rsplit("/", 1)[-1]:
        if digest:
            return None
        name += ":latest"
    for registry in ("docker.io/", "index.docker.io/"):
        if name.startswith(registry):
            name = name[len(registry):]
            break
    if name.startswith("library/") and name.count("/") == 1:
        name = name[len("library/"):]
    return name


def keep_references(state, keep):
    """Image references (tags or IDs) that pruning must keep."""
    runtime = state / "runtime"
    manifest_path = runtime / "release-manifest.json"
    if not manifest_path.is_file():
        raise ValueError("No successful release (runtime/release-manifest.json); nothing was pruned")
    manifest = _json(manifest_path)
    pointer = runtime / "revision"
    current = {**manifest, "revision": pointer.read_text().strip() if pointer.is_file() else ""}
    references = release_images(current)
    for record in history(runtime)[:keep]:
        references |= release_images(record)
    for name in RUNTIME_COMPOSE:
        if (runtime / name).is_file():
            references |= compose_images(runtime / name)
    # Prepared since the last successful release: in progress, or failed and
    # awaiting recovery. A later success makes them eligible.
    published = manifest_path.stat().st_mtime
    for path in (state / "prepared").glob("*/compose.json"):
        if path.stat().st_mtime >= published:
            references |= compose_images(path)
    return references


class Docker:
    """The few Docker CLI calls pruning makes. Any unexpected answer before removal stops it."""

    def __init__(self, run=subprocess.run):
        self._run = run

    def call(self, *args):
        return self._run(["docker", *args], capture_output=True, text=True, check=False)

    def output(self, *args):
        result = self.call(*args)
        if result.returncode != 0:
            raise ValueError(f"docker {args[0]} {args[1]} failed; nothing more was pruned")
        return result.stdout

    def images(self):
        """Top-level images (tagged or dangling) as {id, tags, size}."""
        identities = sorted(set(self.output("image", "ls", "--no-trunc", "--quiet").split()))
        images = []
        for start in range(0, len(identities), 100):
            batch = identities[start:start + 100]
            for image in json.loads(self.output("image", "inspect", *batch)):
                images.append({"id": image["Id"], "tags": image.get("RepoTags") or [], "size": image.get("Size", 0)})
        if any(not IMAGE_ID.fullmatch(image["id"]) for image in images):
            raise ValueError("Docker returned an unexpected image identity; nothing was pruned")
        return images

    def container_images(self):
        """Image IDs of every container, running or stopped."""
        containers = self.output("ps", "--all", "--no-trunc", "--quiet").split()
        if not containers:
            return set()
        identities = set(self.output("container", "inspect", "--format", "{{.Image}}", *containers).split())
        if any(not IMAGE_ID.fullmatch(identity) for identity in identities):
            raise ValueError("Docker returned an unexpected container image; nothing was pruned")
        return identities

    def resolve(self, reference):
        """The image ID a reference names now, or None when no image has it."""
        if IMAGE_ID.fullmatch(reference):
            return reference
        result = self.call("image", "inspect", "--format", "{{.Id}}", reference)
        if result.returncode == 0 and IMAGE_ID.fullmatch(result.stdout.strip()):
            return result.stdout.strip()
        if result.returncode != 0 and "No such image" in result.stderr:
            return None
        raise ValueError(f"Cannot resolve kept image {reference}; nothing was pruned")

    def remove(self, reference, identity):
        """Remove a tag, or an untagged image by its ID, never forced. Returns why not, if it was not.

        A tag is removed only while it still names the listed image: one that
        moved to a newer build since listing is left alone.
        """
        if reference != identity:
            current = self.call("image", "inspect", "--format", "{{.Id}}", reference)
            if current.returncode != 0 or current.stdout.strip() != identity:
                return "the tag no longer names this image; left alone"
        result = self.call("image", "rm", reference)
        return None if result.returncode == 0 else (result.stderr.strip().splitlines() or ["refused"])[-1]

    def prune_build_cache(self, keep_gb):
        """Remove build cache no image uses, least recently and least often used first, down to keep_gb GB.

        --keep-storage is the one size flag both the classic builder and buildx
        accept (buildx 0.17 and later as the deprecated name of --reserved-space,
        which alone sets the same bound). Cache that an image still uses is
        neither counted nor removed, so images go first.
        """
        result = self.call("builder", "prune", "--force", "--keep-storage", f"{keep_gb}GB")
        if result.returncode != 0:
            reason = (result.stderr.strip().splitlines() or ["no reason given"])[-1]
            raise ValueError("docker builder prune failed: " + reason)
        totals = [line.split(":", 1)[1].strip() for line in result.stdout.splitlines() if line.startswith("Total:")]
        return totals[-1] if totals else "0B"


def select(images, kept_ids, kept_tags):
    """What to remove, as (image, references) pairs, in listing order.

    An image nothing keeps goes tag by tag, or by ID when it has no tag. A kept
    image loses only the tags nothing names, and only while a named one
    remains, so pruning never leaves a kept image untagged.
    """
    removals = []
    for image in images:
        if image["id"] not in kept_ids:
            removals.append((image, image["tags"] or [image["id"]]))
        elif kept_tags.intersection(image["tags"]):
            stale = [tag for tag in image["tags"] if tag not in kept_tags]
            if stale:
                removals.append((image, stale))
    return removals


def describe(image):
    return image["id"][7:19] + " " + (", ".join(image["tags"]) or "<untagged>")


def prune(config, state, *, docker=None, dry_run=False):
    """Remove unkept images and tags, then cut build cache; return how many steps failed."""
    docker = docker or Docker()
    keep = keep_releases(config)
    cache_gb = build_cache_keep_gb(config)
    minimum = min_free_gb(config)
    runtime = state / "runtime"
    if not runtime.is_dir():
        raise ValueError("No deployment on this data disk; nothing was pruned")
    # Serialized with finalize, which publishes the receipt pruning reads.
    with (runtime / ".release-manifest.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Listed first: an image created later is never a candidate.
        images = docker.images()
        kept = docker.container_images()
        references = keep_references(state, keep)
        for reference in sorted(references):
            identity = docker.resolve(reference)
            if identity:
                kept.add(identity)
        removals = select(images, kept, {tag for tag in map(repo_tag, references) if tag})
        removable = [image for image, _ in removals if image["id"] not in kept]
        print(f"Keeping {len(images) - len(removable)} of {len(images)} images: every container's, "
              f"the last {keep} successful releases', the runtime Compose definitions' and any prepared "
              "since the last success.")
        print(f"{len(removable)} images to remove, at most {sum(image['size'] for image in removable) / GB:.1f} GB "
              "(layers shared with kept images stay).")
        for image, tags in removals:
            if image["id"] not in kept:
                print(("Would remove " if dry_run else "Removing ") + describe(image))
            else:
                for tag in tags:
                    print(("Would untag " if dry_run else "Untagging ") + f"{tag} from kept image {image['id'][7:19]}")
        if dry_run:
            print(f"Dry run: nothing removed. Prune then cuts build cache to {cache_gb} GB "
                  "(DOCKER_BUILD_CACHE_KEEP_GB).")
            return 0
        before = free_bytes(state)
        failed = 0
        for image, tags in removals:
            for reference in tags:
                reason = docker.remove(reference, image["id"])
                if reason:
                    failed += 1
                    label = describe(image) if reference == image["id"] else f"{reference} ({image['id'][7:19]})"
                    print(f"Kept {label}: {reason}", file=sys.stderr)
        try:
            reclaimed = docker.prune_build_cache(cache_gb)
            print(f"Build cache cut to {cache_gb} GB (DOCKER_BUILD_CACHE_KEEP_GB): {reclaimed} removed.")
        except ValueError as error:
            failed += 1
            print(f"Build cache was not pruned: {error}", file=sys.stderr)
        after = free_bytes(state)
        print(f"Free on the data disk: {before / GB:.1f} GB before, {after / GB:.1f} GB after; "
              f"{max(after - before, 0) / GB:.1f} GB freed.")
        if after < 2 * minimum * GB:
            print(f"Warning: only {after / GB:.1f} GB is free on the data disk, less than twice "
                  f"DOCKER_BUILD_MIN_FREE_GB ({2 * minimum} GB): a build needs {minimum} GB free to start, so "
                  "one may soon be refused. See what holds the space (README: Disk usage and pruning).",
                  file=sys.stderr)
        return failed


def main(argv):
    if len(argv) != 4 or argv[1] not in ("guard", "plan", "prune"):
        raise ValueError("Usage: docker_prune.py guard|plan|prune CONFIG_JSON STATE_DIR")
    try:
        config = json.loads(Path(argv[2]).read_text())
    except (OSError, json.JSONDecodeError):
        raise ValueError("Cannot read the private configuration") from None
    if not isinstance(config, dict):
        raise ValueError("The private configuration must be a JSON object")
    state = Path(argv[3])
    if argv[1] == "guard":
        guard(config, state)
        return 0
    failed = prune(config, state, dry_run=argv[1] == "plan")
    if failed:
        print(f"Pruning did not finish: {failed} step(s) above failed, and what they named was kept.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
