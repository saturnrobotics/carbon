"""Image pruning and the build guard against a synthetic Docker; nothing touches a daemon."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import docker_prune  # noqa: E402
import host_release  # noqa: E402

# Answers the docker CLI calls pruning makes, from a JSON "world"; also run as
# the docker executable in the host-script tests. Unexpected calls exit 99.
DOCKER_STUB = r'''
import json, os, sys


def respond(world, args):
    world.setdefault("log", []).append(args)
    images, containers = world["images"], world.get("containers", {})
    if args == ["image", "ls", "--no-trunc", "--quiet"]:
        if world.get("list_error"):
            return 1, "", "Cannot connect to the Docker daemon"
        return 0, "".join(key + "\n" for key, image in images.items() for _ in image["tags"] or [None]), ""
    if args[:4] == ["image", "inspect", "--format", "{{.Id}}"]:
        if args[4] in world.get("moved", {}):
            return 0, world["moved"][args[4]] + "\n", ""
        for key, image in images.items():
            if args[4] in (key, *image["tags"]):
                return 0, key + "\n", ""
        if world.get("inspect_error"):
            return 1, "", "Cannot connect to the Docker daemon"
        return 1, "", "Error response from daemon: No such image: " + args[4]
    if args[:2] == ["image", "inspect"]:
        return 0, json.dumps([{"Id": key, "RepoTags": images[key]["tags"], "Size": 2 << 30} for key in args[2:]]), ""
    if args == ["ps", "--all", "--no-trunc", "--quiet"]:
        return 0, "".join(key + "\n" for key in containers), ""
    if args[:4] == ["container", "inspect", "--format", "{{.Image}}"]:
        return 0, "".join(containers[key] + "\n" for key in args[4:]), ""
    if args[:2] == ["image", "rm"] and len(args) == 3:
        # As dockerd answers without --force: by ID, only an image with at most
        # one tag and no container; by tag, it untags, refuses the last tag of a
        # container's image, and deletes the image with its last tag.
        named = [key for key, image in images.items() if args[2] == key or args[2] in image["tags"]]
        key = named[0] if named else None
        if key is None:
            return 1, "", "Error response from daemon: No such image: " + args[2]
        tags, conflict = images[key]["tags"], "Error response from daemon: conflict: unable to delete " + key[7:19]
        if key in world.get("refuse", []):
            return 1, "", conflict + " (cannot be forced) - synthetic refusal"
        if key == args[2]:
            if len(tags) > 1:
                return 1, "", conflict + " (must be forced) - image is referenced in multiple repositories"
            if key in containers.values():
                return 1, "", conflict + " (must be forced) - image is being used by stopped container"
            del images[key]
            return 0, "Deleted: " + key + "\n", ""
        if tags == [args[2]] and key in containers.values():
            return 1, "", ('Error response from daemon: conflict: unable to remove repository reference "' + args[2]
                           + '" (must force) - container is using its referenced image ' + key[7:19])
        tags.remove(args[2])
        if tags:
            return 0, "Untagged: " + args[2] + "\n", ""
        del images[key]
        return 0, "Untagged: " + args[2] + "\nDeleted: " + key + "\n", ""
    if args[:4] == ["builder", "prune", "--force", "--keep-storage"] and len(args) == 5:
        if world.get("cache_error"):
            return 1, "", "ERROR: synthetic build cache failure"
        # buildx prints its deprecation notice for --keep-storage on stdout.
        return 0, ("Flag --keep-storage has been deprecated, keep-storage flag has been changed to reserved-space\n"
                   "ID\tRECLAIMABLE\tSIZE\tLAST ACCESSED\nTotal:\t1.5GB\n"), ""
    return 99, "", "unexpected docker call: " + " ".join(args)


if __name__ == "__main__":
    path = os.environ["SYNTHETIC_DOCKER"]
    with open(path) as stream:
        world = json.load(stream)
    code, out, err = respond(world, sys.argv[1:])
    with open(path, "w") as stream:
        json.dump(world, stream)
    sys.stdout.write(out)
    sys.stderr.write(err)
    sys.exit(code)
'''
STUB = {}
exec(compile(DOCKER_STUB, "docker-stub", "exec"), STUB)


def image(number):
    return "sha256:" + format(number, "064x")


def short(identity):
    return identity[7:19]


def commit(character):
    return character * 40


R1, R2, R3, FAILED, SUPERSEDED = commit("1"), commit("2"), commit("3"), commit("f"), commit("e")
IMAGES = {
    # Release generation n built carbon/{erp,mes,ops}:Rn.
    "e1": (image(0x11), ["carbon/erp:" + R1]), "m1": (image(0x12), ["carbon/mes:" + R1]),
    "o1": (image(0x13), ["carbon/ops:" + R1]),
    "e2": (image(0x21), ["carbon/erp:" + R2]), "m2": (image(0x22), ["carbon/mes:" + R2]),
    "o2": (image(0x23), ["carbon/ops:" + R2]),
    "e3": (image(0x31), ["carbon/erp:" + R3]), "m3": (image(0x32), ["carbon/mes:" + R3]),
    "o3": (image(0x33), ["carbon/ops:" + R3]),
    "postgres": (image(0x41), ["supabase/postgres:15.14.1.112"]), "kong": (image(0x42), ["kong:2.8.1"]),
    "old-proxy": (image(0x43), ["caddy:2.7-alpine"]), "dangling": (image(0x44), []),
    "failed": (image(0x51), ["carbon/erp:" + FAILED]), "superseded": (image(0x52), ["carbon/erp:" + SUPERSEDED]),
    "stopped": (image(0x61), ["synthetic/tool:1"]), "running": (image(0x62), ["redis:7"]),
}
ID = {name: identity for name, (identity, _) in IMAGES.items()}


def services(generation):
    revision = commit(str(generation))
    return {name: {"image_digest": ID[name[0] + str(generation)], "source_commit": revision}
            for name in ("erp", "mes")}


def compose(*images):
    return {"services": {f"service-{index}": {"image": reference} for index, reference in enumerate(images)}}


class Host:
    """A synthetic /var/lib/carbon after three successful releases."""

    def __init__(self, root, *, history=True, previous=True):
        self.state = root / "state"
        runtime = self.state / "runtime"
        runtime.mkdir(parents=True)
        # Two deployments failed: one before the last success, one after it.
        self.prepare(SUPERSEDED, compose("carbon/erp:" + SUPERSEDED), age=7200)
        manifest = runtime / "release-manifest.json"
        manifest.write_text(json.dumps({"generation": 3, "services": services(3)}))
        os.utime(manifest, (manifest.stat().st_atime, manifest.stat().st_mtime - 3600))
        (runtime / "revision").write_text(R3 + "\n")
        self.prepare(FAILED, compose("carbon/erp:" + FAILED, "carbon/ops:" + FAILED))
        (runtime / "compose.json").write_text(json.dumps(compose(
            ID["e3"], ID["m3"], "carbon/ops:" + R3, "supabase/postgres:15.14.1.112", "kong:2.8.1", "redis:7")))
        if previous:
            (runtime / "previous-compose.json").write_text(json.dumps(compose(
                ID["e2"], ID["m2"], "carbon/ops:" + R2, "supabase/postgres:15.14.1.112")))
        if history:
            (runtime / host_release.HISTORY).mkdir()
            for generation in (1, 2, 3):
                revision = commit(str(generation))
                record = host_release.release_record(generation, revision, services(generation))
                host_release.write_atomic(host_release.history_path(runtime, generation), record)
        self.world = {
            "images": {identity: {"tags": list(tags)} for identity, tags in IMAGES.values()},
            "containers": {"c" * 64: ID["running"], "d" * 64: ID["stopped"]},
        }

    def prepare(self, revision, definition, age=0):
        path = self.state / "prepared" / revision / "compose.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(definition))
        os.utime(path, (path.stat().st_atime, path.stat().st_mtime - age))

    def docker(self):
        def run(argv, **kwargs):
            if argv[0] != "docker" or kwargs.get("check") is not False:
                raise AssertionError("pruning called Docker unexpectedly")
            code, out, err = STUB["respond"](self.world, argv[1:])
            return subprocess.CompletedProcess(argv, code, out, err)
        return docker_prune.Docker(run=run)

    def prune(self, config=None, *, dry_run=False):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            refused = docker_prune.prune(config or {}, self.state, docker=self.docker(), dry_run=dry_run)
        return refused, output.getvalue(), errors.getvalue()

    def remaining(self):
        return {name for name, identity in ID.items() if identity in self.world["images"]}

    def removals(self):
        return [call for call in self.world.get("log", []) if call[:2] == ["image", "rm"]]

    def cache_prunes(self):
        return [call for call in self.world.get("log", []) if call[0] == "builder"]


class KeepSetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_keeps_the_last_two_releases_containers_runtime_and_unfinished_deployments(self):
        host = Host(self.root)
        refused, output, errors = host.prune()
        self.assertEqual(refused, 0, errors)
        self.assertEqual(ID.keys() - host.remaining(), {"e1", "m1", "o1", "old-proxy", "dangling", "superseded"})
        # By tag (an untagged image by ID), never forced, never a volume or
        # container; then build cache down to its size bound.
        self.assertEqual(sorted(call[2] for call in host.removals()), sorted(
            ["carbon/erp:" + R1, "carbon/mes:" + R1, "carbon/ops:" + R1, "caddy:2.7-alpine", ID["dangling"],
             "carbon/erp:" + SUPERSEDED]))
        self.assertFalse([call for call in host.world["log"] if {"volume", "-f", "--force"} & set(call) and call[0] != "builder"])
        self.assertEqual(host.cache_prunes(), [["builder", "prune", "--force", "--keep-storage", "20GB"]])
        self.assertEqual(host.world["log"][-1][0], "builder")
        self.assertIn("Build cache cut to 20 GB (DOCKER_BUILD_CACHE_KEEP_GB): 1.5GB removed.", output)
        self.assertIn("Removing " + short(ID["e1"]) + " carbon/erp:" + R1, output)

    def test_keep_count_is_configurable(self):
        for keep, removed in ((3, {"old-proxy", "dangling", "superseded"}),
                              (1, {"e1", "m1", "o1", "old-proxy", "dangling", "superseded"})):
            with self.subTest(keep=keep):
                host = Host(self.root / str(keep))
                host.prune({"DOCKER_KEEP_RELEASES": keep})
                self.assertEqual(ID.keys() - host.remaining(), removed)
        # Without a previous Compose definition, one kept release is the current one.
        host = Host(self.root / "current-only", previous=False)
        host.prune({"DOCKER_KEEP_RELEASES": 1})
        self.assertTrue({"e2", "m2", "o2"}.isdisjoint(host.remaining()))
        self.assertTrue({"e3", "m3", "o3", "postgres"} <= host.remaining())

    def test_before_any_history_the_manifest_and_runtime_compose_keep_two_releases(self):
        host = Host(self.root, history=False)
        host.prune()
        self.assertTrue({"e2", "m2", "o2", "e3", "m3", "o3"} <= host.remaining())
        self.assertTrue({"e1", "m1", "o1"}.isdisjoint(host.remaining()))

    def test_a_later_success_releases_a_failed_deployments_images(self):
        host = Host(self.root)
        host.prune()
        self.assertIn("failed", host.remaining())
        manifest = host.state / "runtime/release-manifest.json"
        os.utime(manifest, (manifest.stat().st_atime, manifest.stat().st_mtime + 7200))
        host.prune()
        self.assertNotIn("failed", host.remaining())

    def test_finalize_records_feed_the_keep_set(self):
        runtime = self.root / "runtime"
        runtime.mkdir()
        (runtime / host_release.HISTORY).mkdir()
        record = host_release.release_record(
            4, R3, {"erp": {"image_digest": ID["e3"], "source_commit": R2, "config_digest": "x"}},
            ["kong:2.8.1", ID["m3"], "kong:2.8.1"])
        self.assertEqual(record, {"generation": 4, "revision": R3, "images": ["kong:2.8.1", ID["m3"]],
                                  "services": {"erp": {"image_digest": ID["e3"], "source_commit": R2}}})
        self.assertEqual(docker_prune.release_images(record),
                         {ID["e3"], ID["m3"], "kong:2.8.1", "carbon/erp:" + R2, "carbon/ops:" + R3})

    def test_dry_run_removes_nothing(self):
        host = Host(self.root)
        refused, output, _ = host.prune(dry_run=True)
        self.assertEqual(refused, 0)
        self.assertEqual(host.remaining(), set(ID))
        self.assertEqual(host.removals(), [])
        self.assertEqual(host.cache_prunes(), [])
        self.assertIn("Would remove " + short(ID["e1"]), output)
        self.assertIn("6 images to remove", output)
        self.assertIn("cuts build cache to 20 GB", output)

    def test_images_go_tag_by_tag_and_kept_images_lose_only_unnamed_tags(self):
        host = Host(self.root)
        images, twin = host.world["images"], image(0x15)
        stale = ["carbon/erp:" + commit(character) for character in "abc"]
        # One build tagged for two commits nothing keeps: Docker refuses its ID
        # without force, and deletes it with its last tag.
        images[twin] = {"tags": stale[:2]}
        # The current release's image, also tagged for a commit nothing keeps.
        images[ID["e3"]]["tags"].append(stale[2])
        # A running container's image: Compose names redis:7, nothing names latest.
        images[ID["running"]]["tags"].append("redis:latest")
        # A stopped container's image with two tags nothing names: both stay.
        images[ID["stopped"]]["tags"].append("synthetic/tool:latest")
        _, plan, _ = host.prune(dry_run=True)
        self.assertIn("7 images to remove", plan)
        self.assertIn("Would untag " + stale[2] + " from kept image " + short(ID["e3"]), plan)
        refused, output, errors = host.prune()
        self.assertEqual(refused, 0, errors)
        self.assertNotIn(twin, images)
        self.assertEqual(ID.keys() - host.remaining(), {"e1", "m1", "o1", "old-proxy", "dangling", "superseded"})
        self.assertEqual(images[ID["e3"]]["tags"], ["carbon/erp:" + R3])
        self.assertEqual(images[ID["running"]]["tags"], ["redis:7"])
        self.assertEqual(images[ID["stopped"]]["tags"], ["synthetic/tool:1", "synthetic/tool:latest"])
        removed = [call[2] for call in host.removals()]
        self.assertTrue({*stale, "redis:latest"} <= set(removed))
        # Only the untagged image goes by ID.
        self.assertEqual([reference for reference in removed if reference.startswith("sha256:")], [ID["dangling"]])
        self.assertIn("Untagging " + stale[2] + " from kept image " + short(ID["e3"]), output)

    def test_a_tag_that_moved_to_a_newer_build_is_left_alone(self):
        host = Host(self.root)
        # carbon/erp:R1 now names an image built after listing.
        host.world["moved"] = {"carbon/erp:" + R1: image(0x71)}
        refused, _, errors = host.prune()
        self.assertEqual(refused, 1)
        self.assertNotIn(["image", "rm", "carbon/erp:" + R1], host.removals())
        self.assertIn("Kept carbon/erp:" + R1 + " (" + short(ID["e1"]) + "): the tag no longer names this image",
                      errors)
        self.assertIn("e1", host.remaining())

    def test_build_cache_is_cut_to_its_configured_size(self):
        for config, flag in (({}, "20GB"), ({"DOCKER_BUILD_CACHE_KEEP_GB": 50}, "50GB")):
            with self.subTest(flag=flag):
                host = Host(self.root / flag)
                refused, output, errors = host.prune(config)
                self.assertEqual(refused, 0, errors)
                # One size-bounded prune, after every image removal.
                self.assertEqual(host.cache_prunes(), [["builder", "prune", "--force", "--keep-storage", flag]])
                self.assertEqual(host.world["log"][-1], host.cache_prunes()[0])
                self.assertIn(f"Build cache cut to {flag[:-2]} GB", output)

    def test_reports_the_space_freed_and_warns_while_little_remains(self):
        gb = docker_prune.GB
        # The live first run freed nothing: 29.3 GB before and after.
        for label, config, before, after, twice in (("low", {}, 29.3, 29.3, 30), ("enough", {}, 29.3, 84.6, None),
                                                    ("tuned", {"DOCKER_BUILD_MIN_FREE_GB": 25}, 10.0, 45.5, 50)):
            with self.subTest(label), patch.object(docker_prune, "free_bytes", side_effect=[before * gb, after * gb]):
                refused, output, errors = Host(self.root / label).prune(config)
                self.assertEqual(refused, 0, errors)
                self.assertIn(f"Free on the data disk: {before:.1f} GB before, {after:.1f} GB after; "
                              f"{after - before:.1f} GB freed.", output)
                if twice:
                    self.assertIn(f"Warning: only {after:.1f} GB is free on the data disk, less than twice "
                                  f"DOCKER_BUILD_MIN_FREE_GB ({twice} GB)", errors)
                else:
                    self.assertNotIn("Warning", errors)

    def test_failures_are_reported_while_the_rest_continue(self):
        host = Host(self.root)
        host.world["refuse"] = [ID["old-proxy"]]
        host.world["cache_error"] = True
        refused, output, errors = host.prune()
        # A tag no image has any longer (carbon/ops of the failed deployment) is
        # simply absent; a refusal or a failed cache prune is reported, the rest
        # continue, and the free-space report still follows.
        self.assertEqual(refused, 2)
        self.assertIn("Kept caddy:2.7-alpine (" + short(ID["old-proxy"]) + "): Error response from daemon", errors)
        self.assertIn("Build cache was not pruned: docker builder prune failed: ERROR: synthetic build cache failure",
                      errors)
        self.assertEqual(ID.keys() - host.remaining(), {"e1", "m1", "o1", "dangling", "superseded"})
        self.assertEqual(len(host.cache_prunes()), 1)
        self.assertIn("Free on the data disk", output)

    def test_unexpected_state_or_docker_answers_remove_nothing(self):
        def corrupt_history(host):
            (host.state / "runtime" / host_release.HISTORY / "00000009.json").write_text('{"generation": "9"}')

        def unreadable_compose(host):
            (host.state / "runtime/previous-compose.json").write_text("{")

        cases = {
            "no successful release": (lambda host: (host.state / "runtime/release-manifest.json").unlink(),
                                      "No successful release"),
            "invalid history": (corrupt_history, "Invalid release history"),
            "unreadable compose": (unreadable_compose, "Cannot read"),
            "inspect error": (lambda host: host.world.update(inspect_error=True), "Cannot resolve kept image"),
            "list error": (lambda host: host.world.update(list_error=True), "docker image ls failed"),
        }
        for label, (change, message) in cases.items():
            with self.subTest(label):
                host = Host(self.root / label.replace(" ", "-"))
                change(host)
                with self.assertRaisesRegex(ValueError, message):
                    host.prune()
                self.assertEqual(host.removals(), [])
                self.assertNotIn("builder", [call[0] for call in host.world.get("log", [])])

    def test_no_deployment_is_refused(self):
        with self.assertRaisesRegex(ValueError, "No deployment"):
            docker_prune.prune({}, self.root / "missing", docker=docker_prune.Docker(run=None))


class GuardTests(unittest.TestCase):
    def guard(self, free_gb, config=None):
        stat = os.statvfs_result((4096, 4096, 0, 0, int(free_gb * docker_prune.GB) // 4096, 0, 0, 0, 0, 255))
        output = io.StringIO()
        with patch.object(docker_prune.os, "statvfs", return_value=stat) as statvfs, redirect_stdout(output):
            docker_prune.guard(config or {}, Path("/synthetic/state"))
        statvfs.assert_called_once_with(Path("/synthetic/state"))
        return output.getvalue()

    def test_refuses_a_build_below_the_threshold(self):
        with self.assertRaisesRegex(ValueError, r"Only 14\.9 GB is free.*at least 15 GB.*Nothing was built or stopped"):
            self.guard(14.9)
        self.assertIn("15.0 GB free", self.guard(15))
        with self.assertRaisesRegex(ValueError, "at least 40 GB"):
            self.guard(39, {"DOCKER_BUILD_MIN_FREE_GB": 40})
        self.assertIn("5.0 GB free", self.guard(5, {"DOCKER_BUILD_MIN_FREE_GB": 5}))

    def test_settings_are_validated(self):
        docker_prune.validate({})
        docker_prune.validate({"DOCKER_KEEP_RELEASES": 1, "DOCKER_BUILD_MIN_FREE_GB": 10000,
                               "DOCKER_BUILD_CACHE_KEEP_GB": 1})
        for key, value in (("DOCKER_KEEP_RELEASES", 0), ("DOCKER_KEEP_RELEASES", 21), ("DOCKER_KEEP_RELEASES", "2"),
                           ("DOCKER_KEEP_RELEASES", True), ("DOCKER_KEEP_RELEASES", 2.0),
                           ("DOCKER_BUILD_MIN_FREE_GB", 0), ("DOCKER_BUILD_MIN_FREE_GB", 10001),
                           ("DOCKER_BUILD_MIN_FREE_GB", None), ("DOCKER_BUILD_CACHE_KEEP_GB", 0),
                           ("DOCKER_BUILD_CACHE_KEEP_GB", 10001), ("DOCKER_BUILD_CACHE_KEEP_GB", "20GB")):
            with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, key):
                docker_prune.validate({key: value})


class HostScriptTests(unittest.TestCase):
    """host-deploy.sh with its state directory moved to a temporary one and stub host commands."""

    def run_host(self, action, config, *, world=None, tls=True):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            if world is not None:
                state = world.state
            else:
                state = root / "state"
                state.mkdir()
            if tls:
                (state / "tls/live/carbon").mkdir(parents=True, exist_ok=True)
                for name in ("fullchain.pem", "privkey.pem"):
                    (state / "tls/live/carbon" / name).write_text("synthetic")
            script = (HERE / "host-deploy.sh").read_text()
            self.assertEqual(script.count("readonly STATE=/var/lib/carbon\n"), 1)
            (root / "host-deploy.sh").write_text(script.replace("readonly STATE=/var/lib/carbon\n", f"readonly STATE='{state}'\n"))
            bin_dir = root / "bin"
            bin_dir.mkdir()
            (bin_dir / "docker").write_text("#!/usr/bin/env python3\n" + DOCKER_STUB)
            (bin_dir / "id").write_text("#!/bin/sh\necho 0\n")
            (bin_dir / "ip").write_text("#!/bin/sh\nprintf '2: ens4    inet 10.73.8.2/32 scope global ens4\\n'\n")
            for name in ("docker", "id", "ip"):
                (bin_dir / name).chmod(0o755)
            for name in ("bash", "grep", "cat", "mkdir"):
                (bin_dir / name).symlink_to(shutil.which(name))
            # Exec, not a symlink, so a virtual environment's PyYAML stays importable.
            (bin_dir / "python3").write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} \"$@\"\n")
            (bin_dir / "python3").chmod(0o755)
            docker_world = root / "docker.json"
            docker_world.write_text(json.dumps(world.world if world is not None else {"images": {}}))
            (root / "config.json").write_text(json.dumps({"DEPLOY_REVISION": R3, "POSTGRES_PRIVATE_IP": "10.73.8.2",
                                                          **config}))
            result = subprocess.run(
                ["bash", str(root / "host-deploy.sh"), str(root / "config.json"), str(HERE.parents[2]), action],
                env={"PATH": str(bin_dir), "HOME": temporary, "SYNTHETIC_DOCKER": str(docker_world)},
                capture_output=True, text=True, timeout=60)
            return result, json.loads(docker_world.read_text())

    def test_prepare_refuses_to_build_without_free_space_before_anything_runs(self):
        free_gb = shutil.disk_usage(tempfile.gettempdir()).free // docker_prune.GB
        building = {"INGRESS_MODE": "private-lb", "RELEASE_MAINTENANCE": False,
                    "RELEASE_PLAN": {"build": {"erp": ["source changed"]}, "migrate": {}}}
        for plan in (building, {**building, "RELEASE_PLAN": {"build": {}, "migrate": {}}, "RELEASE_MAINTENANCE": True}):
            with self.subTest(plan=plan):
                result, docker = self.run_host("prepare", {**plan, "DOCKER_BUILD_MIN_FREE_GB": free_gb + 10})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Nothing was built or stopped", result.stderr)
                self.assertEqual(docker.get("log", []), [])
        # Enough space: the guard passes and preparation continues (to rendering,
        # which this synthetic configuration cannot satisfy).
        result, docker = self.run_host("prepare", {**building, "DOCKER_BUILD_MIN_FREE_GB": 1})
        self.assertIn("GB free on the data disk", result.stdout)
        self.assertIn("Cannot render private stack", result.stderr)
        self.assertEqual(docker.get("log", []), [])

    def test_prepare_without_a_build_is_not_checked(self):
        free_gb = shutil.disk_usage(tempfile.gettempdir()).free // docker_prune.GB
        result, _ = self.run_host("prepare", {"INGRESS_MODE": "private-lb", "RELEASE_MAINTENANCE": False,
                                              "RELEASE_PLAN": {"build": {}, "migrate": {}, "deploy": {"erp": []}},
                                              "DOCKER_BUILD_MIN_FREE_GB": free_gb + 10})
        self.assertNotIn("GB free", result.stdout + result.stderr)
        self.assertIn("Cannot render private stack", result.stderr)

    def test_prune_and_plan_actions_behave_the_same_in_both_ingress_modes(self):
        outputs = {}
        for mode in ({}, {"INGRESS_MODE": "tailscale"}, {"INGRESS_MODE": "private-lb"}):
            with tempfile.TemporaryDirectory() as temporary, self.subTest(mode=mode):
                host = Host(Path(temporary))
                result, docker = self.run_host("prune-plan", mode, world=host, tls=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(set(docker["images"]), set(host.world["images"]))
                result, docker = self.run_host("prune", mode, world=host, tls=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                host.world = docker
                self.assertEqual(ID.keys() - host.remaining(), {"e1", "m1", "o1", "old-proxy", "dangling", "superseded"})
                outputs[json.dumps(mode)] = result.stdout.split("Free on the data disk")[0]
        self.assertEqual(len(set(outputs.values())), 1)

    def test_a_failed_prune_step_exits_nonzero_after_the_rest(self):
        # deploy.py turns this exit status into a warning (test_deploy_lifecycle).
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(Path(temporary))
            host.world.update(refuse=[ID["old-proxy"]], cache_error=True)
            result, docker = self.run_host("prune", {}, world=host, tls=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn("Pruning did not finish: 2 step(s) above failed", result.stderr)
            host.world = docker
            self.assertEqual(ID.keys() - host.remaining(), {"e1", "m1", "o1", "dangling", "superseded"})
            self.assertIn("Free on the data disk", result.stdout)

    def test_prune_without_a_release_fails_closed(self):
        result, docker = self.run_host("prune", {}, tls=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No deployment", result.stderr)
        self.assertEqual(docker.get("log", []), [])


if __name__ == "__main__":
    unittest.main()
