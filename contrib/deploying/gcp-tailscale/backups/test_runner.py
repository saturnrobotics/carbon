import contextlib
import datetime as dt
import io
import json
import unittest
import urllib.parse
from unittest.mock import patch

from runner import (
    Api, ApiError, BackupError, Config, MANAGED, Runner, UTC,
    blob_key, crc32c, json_bytes, select_versions, stamp,
)


START = dt.datetime(2026, 9, 6, 7, tzinfo=UTC)


def config(**changes):
    data = dict(project="example-project", zone="us-east1-b", disk="example-data",
                name="example", location="us", bucket="example-backups",
                source_buckets=["example-attachments"], daily_days=90, monthly_days=366,
                monitoring_metric="custom.googleapis.com/carbon_backup/last_success")
    data.update(changes)
    return Config.parse(json.dumps(data))


def snapshot(cfg, day, *, recovery="daily", disk_id="42", status="READY"):
    days = cfg.monthly_days if recovery == "monthly" else cfg.daily_days
    return {"name": cfg.name + "-cold-" + day.strftime("%Y%m%d"), "id": day.strftime("%Y%m%d"),
            "sourceDisk": "https://www.googleapis.com/compute/v1/" + cfg.disk_path,
            "sourceDiskId": disk_id, "snapshotType": "ARCHIVE", "status": status,
            "storageLocations": [cfg.location], "creationTimestamp": stamp(day),
            "labels": {"managed_by": MANAGED, "backup_series": cfg.name, "recovery": recovery,
                       "expires_on": (day.date() + dt.timedelta(days=days)).isoformat()}}


class MemoryApi(Api):
    """In-memory service enforcing generations, pagination and conditional writes."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.now = START
        self.snapshots = {}
        self.objects = {}
        self.next_generation = 100
        self.calls = []
        self.versioning = True
        self.fail_manifest = False
        self.rewrite_steps = False
        self.pages_seen = []

    def put_object(self, bucket, name, data=b"content", *, storage_class="STANDARD", metadata=None,
                   deleted=None, created=None):
        self.next_generation += 1
        generation = str(self.next_generation)
        value = {"bucket": bucket, "name": name, "generation": generation,
                 "size": str(len(data)), "crc32c": crc32c(data), "storageClass": storage_class,
                 "timeCreated": stamp(created or self.now), "metadata": metadata or {}}
        if deleted is not None:
            value["timeDeleted"] = stamp(deleted)
        self.objects[(bucket, name, generation)] = (value, data)
        return value

    def existing(self, bucket, name, query):
        candidates = [value for (b, n, gen), value in self.objects.items()
                      if b == bucket and n == name and
                      (gen == str(query["generation"]) if "generation" in query else not value[0].get("timeDeleted"))]
        if not candidates:
            raise ApiError(404)
        return max(candidates, key=lambda value: int(value[0]["generation"]))

    def page(self, items, query):
        self.pages_seen.append(dict(query))
        offset = int(query.get("pageToken", 0))
        result = {"items": items[offset:offset + 2]}
        if offset + 2 < len(items):
            result["nextPageToken"] = str(offset + 2)
        return result

    def request(self, method, url, *, query=None, body=None, raw=None, content_type=None, media=False):
        query = dict(query or {})
        self.calls.append((method, url, query, body))
        path = urllib.parse.urlsplit(url).path
        if "monitoring.googleapis.com" in url:
            return {}
        if "compute.googleapis.com" in url:
            if "/disks/" in path:
                if path != "/compute/v1/" + self.cfg.disk_path:
                    raise AssertionError("incorrect disk API path")
                return {"id": "42"}
            if path.endswith("/snapshots"):
                if method == "GET":
                    return self.page(list(self.snapshots.values()), query)
                result = dict(body, id=str(len(self.snapshots) + 1), sourceDiskId="42", status="READY",
                              creationTimestamp=stamp(self.now))
                self.snapshots[body["name"]] = result
                return {"name": "operation"}
            name = urllib.parse.unquote(path.rsplit("/", 1)[-1])
            if name not in self.snapshots:
                raise ApiError(404)
            if method == "DELETE":
                del self.snapshots[name]
                return {}
            return dict(self.snapshots[name])
        rest = path.split("/b/", 1)[1]
        bucket, _, remainder = rest.partition("/o")
        bucket = urllib.parse.unquote(bucket)
        if "/upload/" in path:
            boundary = content_type.split("boundary=", 1)[1].encode()
            chunks = raw.split(b"--" + boundary)
            metadata = json.loads(chunks[1].split(b"\r\n\r\n", 1)[1].removesuffix(b"\r\n"))
            data = chunks[2].split(b"\r\n\r\n", 1)[1].removesuffix(b"\r\n")
            name = metadata["name"]
            if self.fail_manifest and name.startswith("manifests/"):
                raise ApiError(503)
            try:
                current, _ = self.existing(bucket, name, {})
                if str(query["ifGenerationMatch"]) != current["generation"]:
                    raise ApiError(412)
                del self.objects[(bucket, name, current["generation"])]
            except ApiError as exc:
                if exc.status != 404:
                    raise
                if str(query["ifGenerationMatch"]) != "0":
                    raise ApiError(412)
            if metadata["crc32c"] != crc32c(data):
                raise ApiError(400)
            return self.put_object(bucket, name, data, storage_class=metadata["storageClass"], metadata=metadata["metadata"])
        if not _:
            return {"versioning": {"enabled": self.versioning}}
        if remainder == "":
            items = [dict(item) for (b, _, _gen), (item, _data) in self.objects.items()
                     if b == bucket and item["name"].startswith(query.get("prefix", ""))
                     and (query.get("versions") == "true" or not item.get("timeDeleted"))]
            return self.page(sorted(items, key=lambda item: (item["name"], item["generation"])), query)
        if "/rewriteTo/" in remainder:
            source_name, destination = remainder[1:].split("/rewriteTo/b/", 1)
            source_name = urllib.parse.unquote(source_name)
            destination_bucket, destination_name = destination.split("/o/", 1)
            destination_bucket, destination_name = map(urllib.parse.unquote, (destination_bucket, destination_name))
            if self.rewrite_steps and "rewriteToken" not in query:
                return {"done": False, "rewriteToken": "next-page"}
            source, data = self.existing(bucket, source_name, {"generation": query["sourceGeneration"]})
            try:
                self.existing(destination_bucket, destination_name, {})
                raise ApiError(412)
            except ApiError as exc:
                if exc.status != 404:
                    raise
            result = self.put_object(destination_bucket, destination_name, data,
                                     storage_class=body["storageClass"], metadata=body["metadata"])
            return {"done": True, "resource": result}
        name = urllib.parse.unquote(remainder[1:])
        item, data = self.existing(bucket, name, query)
        if method == "DELETE":
            if str(query.get("ifGenerationMatch")) != item["generation"]:
                raise ApiError(412)
            del self.objects[(bucket, name, item["generation"])]
            return {}
        return data if media else dict(item)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.cfg = config()
        self.api = MemoryApi(self.cfg)
        self.runner = Runner(self.cfg, self.api, clock=lambda: self.api.now, sleep=lambda _: None)

    def run_quiet(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.runner.run()

    def add_manifest(self, snap, entries=None):
        value = {"schemaVersion": 1, "status": "COMPLETE", "backupSeries": self.cfg.name,
                 "snapshot": self.runner.snapshot_record(snap), "sourceBuckets": list(self.cfg.source_buckets),
                 "objects": entries or [], "objectCount": len(entries or []),
                 "startedAt": snap["creationTimestamp"], "completedAt": snap["creationTimestamp"]}
        self.runner.write_json("manifests/" + snap["name"] + ".json", value)
        return value

    def test_crc32c_standard_vector(self):
        self.assertEqual(crc32c(b"123456789"), "4waSgw==")

    def test_config_rejects_unsafe_or_expensive_short_retention(self):
        for changes in ({"name": "../bad"}, {"daily_days": 89}, {"monthly_days": 365},
                        {"source_buckets": "example-attachments"}, {"bucket": "example-attachments"},
                        {"monitoring_metric": "private arbitrary name"}):
            with self.subTest(changes=changes), self.assertRaises(BackupError):
                config(**changes)

    def test_selects_live_and_concurrently_deleted_versions(self):
        old = self.api.put_object(self.cfg.source_buckets[0], "old", deleted=START - dt.timedelta(seconds=61))
        boundary = self.api.put_object(self.cfg.source_buckets[0], "boundary", deleted=START - dt.timedelta(seconds=60))
        later = self.api.put_object(self.cfg.source_buckets[0], "later", deleted=START + dt.timedelta(hours=1))
        live = self.api.put_object(self.cfg.source_buckets[0], "live")
        self.assertEqual(select_versions([old, boundary, later, live], START), [boundary, later, live])

    def test_retention_honors_full_elapsed_days(self):
        old = snapshot(self.cfg, START)
        self.api.now = START + dt.timedelta(days=90, microseconds=-1)
        self.assertFalse(self.runner.expired(old))
        self.api.now += dt.timedelta(microseconds=1)
        self.assertTrue(self.runner.expired(old))
        monthly = snapshot(self.cfg, START, recovery="monthly")
        self.api.now = START + dt.timedelta(days=365)
        self.assertFalse(self.runner.expired(monthly))
        self.api.now = START + dt.timedelta(days=366)
        self.assertTrue(self.runner.expired(monthly))

    def test_foreign_snapshots_are_never_owned(self):
        original = snapshot(self.cfg, START)
        self.assertTrue(self.runner.owned(original, "42"))
        for change in ({"sourceDiskId": "99"}, {"sourceDisk": "projects/other/zones/us-east1-b/disks/example-data"},
                       {"name": "example-predeploy-20260906"}, {"snapshotType": "STANDARD"},
                       {"autoCreated": True}, {"sourceSnapshotSchedulePolicy": "policy"},
                       {"storageLocations": ["eu"]}, {"labels": {}},
                       {"labels": {**original["labels"], "expires_on": "2026-09-07"}}):
            self.assertFalse(self.runner.owned({**original, **change}, "42"))

    def test_pagination_and_rewrite_continuation(self):
        self.api.rewrite_steps = True
        for index in range(5):
            self.api.put_object(self.cfg.source_buckets[0], f"synthetic-{index}")
        result = self.run_quiet()
        self.assertEqual(result["objects"], 5)
        rewrites = [call for call in self.api.calls if "/rewriteTo/" in call[1]]
        self.assertEqual(len(rewrites), 10)
        self.assertTrue(any(call[2].get("rewriteToken") == "next-page" for call in rewrites))
        self.assertTrue(any(page.get("pageToken") == "4" for page in self.api.pages_seen))
        self.assertTrue(all(call[2]["ifGenerationMatch"] == 0 for call in rewrites))

    def test_snapshot_list_pagination(self):
        for days in range(5):
            snap = snapshot(self.cfg, START - dt.timedelta(days=days))
            self.api.snapshots[snap["name"]] = snap
        self.assertEqual(len(self.runner.snapshot_list()), 5)
        self.assertEqual([page.get("pageToken") for page in self.api.pages_seen], [None, "2", "4"])

    def test_same_day_retry_reuses_snapshot_manifest_and_copies(self):
        self.api.put_object(self.cfg.source_buckets[0], "synthetic-invoice")
        self.assertEqual(self.run_quiet()["status"], "success")
        rewrites = sum("/rewriteTo/" in call[1] for call in self.api.calls)
        self.assertEqual(self.run_quiet()["status"], "success")
        self.assertEqual(len(self.api.snapshots), 1)
        self.assertEqual(sum("/rewriteTo/" in call[1] for call in self.api.calls), rewrites)
        heartbeat = [call for call in self.api.calls if "monitoring.googleapis.com" in call[1]]
        self.assertEqual(len(heartbeat), 2)

    def test_corrupted_existing_copy_is_rejected(self):
        source = self.api.put_object(self.cfg.source_buckets[0], "synthetic-invoice", b"correct")
        self.api.put_object(self.cfg.bucket, blob_key(self.cfg.source_buckets[0], source), b"wrong",
                            storage_class="ARCHIVE", metadata={"managed_by": MANAGED, "backup_series": self.cfg.name})
        with self.assertRaisesRegex(BackupError, "BACKUP_OBJECT_MISMATCH"):
            self.run_quiet()
        self.assertFalse(any("monitoring.googleapis.com" in call[1] for call in self.api.calls))

    def test_complete_manifest_retry_revalidates_copies(self):
        self.api.put_object(self.cfg.source_buckets[0], "synthetic-invoice")
        self.run_quiet()
        for key, (meta, data) in self.api.objects.items():
            if key[1].startswith("objects/"):
                meta["crc32c"] = crc32c(b"corrupt")
        with self.assertRaisesRegex(BackupError, "BACKUP_OBJECT_MISMATCH"):
            self.run_quiet()

    def test_partial_backup_never_prunes_and_can_retry(self):
        old = snapshot(self.cfg, START - dt.timedelta(days=91))
        self.api.snapshots[old["name"]] = old
        self.add_manifest(old)
        self.api.fail_manifest = True
        with self.assertRaises(ApiError):
            self.run_quiet()
        self.assertIn(old["name"], self.api.snapshots)
        self.assertFalse(any(call[0] == "DELETE" and "/snapshots/" in call[1] for call in self.api.calls))
        self.api.fail_manifest = False
        self.assertEqual(self.run_quiet()["status"], "success")
        self.assertNotIn(old["name"], self.api.snapshots)

    def test_expired_partial_snapshots_are_collected_without_touching_recent_or_foreign(self):
        expired = snapshot(self.cfg, START - dt.timedelta(days=367), recovery="monthly")
        recent = snapshot(self.cfg, START - dt.timedelta(days=89))
        foreign = snapshot(self.cfg, START - dt.timedelta(days=200), disk_id="99")
        for snap in (expired, recent, foreign):
            self.api.snapshots[snap["name"]] = snap
        self.assertEqual(self.run_quiet()["status"], "success")
        self.assertNotIn(expired["name"], self.api.snapshots)
        self.assertIn(recent["name"], self.api.snapshots)
        self.assertIn(foreign["name"], self.api.snapshots)

    def test_partial_cleanup_preserves_newest_and_requires_complete_success(self):
        successful = snapshot(self.cfg, START - dt.timedelta(days=400))
        newest = snapshot(self.cfg, START - dt.timedelta(days=399))
        older = snapshot(self.cfg, START - dt.timedelta(days=401))
        for snap in (successful, newest, older):
            self.api.snapshots[snap["name"]] = snap
        with self.assertRaisesRegex(BackupError, "NO_COMPLETE_RECOVERY_POINT"):
            self.runner.prune("42", successful)
        self.assertEqual(len(self.api.snapshots), 3)
        self.add_manifest(successful)
        self.assertEqual(self.runner.prune("42", successful), (1, 0))
        self.assertIn(successful["name"], self.api.snapshots)
        self.assertIn(newest["name"], self.api.snapshots)

    def old_manifest_entry(self, suffix="old"):
        old_time = START - dt.timedelta(days=400)
        source = self.api.put_object(self.cfg.source_buckets[0], "synthetic-" + suffix,
                                     created=old_time, deleted=START - dt.timedelta(days=100))
        target = self.api.put_object(self.cfg.bucket, blob_key(self.cfg.source_buckets[0], source),
                                     storage_class="ARCHIVE", created=old_time,
                                     metadata={"managed_by": MANAGED, "backup_series": self.cfg.name})
        fields = ("bucket", "name", "generation", "size", "crc32c")
        return {"source": {key: source[key] for key in fields},
                "backup": {key: target[key] for key in fields}}

    def test_retry_reconciles_manifest_after_snapshot_deleted_before_manifest_delete(self):
        old = snapshot(self.cfg, START - dt.timedelta(days=100))
        self.api.snapshots[old["name"]] = old
        entry = self.old_manifest_entry()
        self.add_manifest(old, [entry])
        original = self.api.request

        def fail_manifest_delete(method, url, **kwargs):
            if method == "DELETE" and urllib.parse.unquote(url).endswith("manifests/" + old["name"] + ".json"):
                raise ApiError(503)
            return original(method, url, **kwargs)

        with patch.object(self.api, "request", side_effect=fail_manifest_delete), self.assertRaises(ApiError):
            self.run_quiet()
        self.assertNotIn(old["name"], self.api.snapshots)
        self.assertTrue(any(key[1] == "manifests/" + old["name"] + ".json" for key in self.api.objects))
        self.assertEqual(self.run_quiet()["status"], "success")
        self.assertFalse(any(key[1] in ("manifests/" + old["name"] + ".json", entry["backup"]["name"])
                             for key in self.api.objects))

    def test_recent_and_previous_disk_orphans_keep_their_copies(self):
        recent = snapshot(self.cfg, START - dt.timedelta(days=89))
        previous = snapshot(self.cfg, START - dt.timedelta(days=400), disk_id="99")
        entries = [self.old_manifest_entry("recent"), self.old_manifest_entry("previous")]
        self.add_manifest(recent, [entries[0]])
        self.add_manifest(previous, [entries[1]])
        self.assertEqual(self.run_quiet()["status"], "success")
        for snap, entry in zip((recent, previous), entries):
            self.assertTrue(any(key[1] == "manifests/" + snap["name"] + ".json" for key in self.api.objects))
            self.assertTrue(any(key[1] == entry["backup"]["name"] for key in self.api.objects))

    def test_malformed_current_disk_orphan_aborts_all_retention(self):
        orphan = snapshot(self.cfg, START - dt.timedelta(days=200))
        orphan["sourceDisk"] = "projects/other/zones/us-east1-b/disks/unrelated"
        manifest = self.add_manifest(orphan, [self.old_manifest_entry()])
        # snapshot_record normally pins the path; inject a malformed saved record.
        manifest["snapshot"]["sourceDisk"] = orphan["sourceDisk"]
        name = "manifests/" + orphan["name"] + ".json"
        _, metadata = self.runner.read_json(name)
        self.runner.write_json(name, manifest, metadata["generation"])
        expired = snapshot(self.cfg, START - dt.timedelta(days=367), recovery="monthly")
        self.api.snapshots[expired["name"]] = expired
        with self.assertRaisesRegex(BackupError, "INVALID_ORPHAN_MANIFEST"):
            self.run_quiet()
        self.assertIn(expired["name"], self.api.snapshots)
        self.assertFalse(any(call[0] == "DELETE" and "/snapshots/" in call[1] for call in self.api.calls))

    def test_snapshot_retention_change_before_delete_is_respected(self):
        old = snapshot(self.cfg, START - dt.timedelta(days=100))
        promoted = snapshot(self.cfg, START - dt.timedelta(days=100), recovery="monthly")
        self.api.snapshots[old["name"]] = promoted
        with self.assertRaisesRegex(BackupError, "PRUNE_SNAPSHOT_CHANGED"):
            self.runner.delete_snapshot(old)
        self.assertIn(old["name"], self.api.snapshots)

    def test_missing_versioning_blocks_completion(self):
        self.api.versioning = False
        with self.assertRaisesRegex(BackupError, "SOURCE_VERSIONING_REQUIRED"):
            self.run_quiet()
        self.assertFalse(any(key[1].startswith("manifests/") for key in self.api.objects))

    def test_first_successful_snapshot_each_month_gets_long_retention(self):
        self.run_quiet()
        first = next(iter(self.api.snapshots.values()))
        self.assertEqual(first["labels"]["recovery"], "monthly")
        self.api.now += dt.timedelta(days=1)
        self.run_quiet()
        latest = max(self.api.snapshots.values(), key=lambda value: value["name"])
        self.assertEqual(latest["labels"]["recovery"], "daily")
        self.api.now = dt.datetime(2026, 10, 1, 7, tzinfo=UTC)
        self.run_quiet()
        latest = max(self.api.snapshots.values(), key=lambda value: value["name"])
        self.assertEqual(latest["labels"]["recovery"], "monthly")

    def test_prune_preserves_newest_even_after_expiry(self):
        old = snapshot(self.cfg, START - dt.timedelta(days=100))
        self.api.snapshots[old["name"]] = old
        self.add_manifest(old)
        self.assertEqual(self.runner.prune("42", old), (0, 0))
        self.assertIn(old["name"], self.api.snapshots)

    def test_blob_gc_age_and_live_source_guards(self):
        source = self.api.put_object(self.cfg.source_buckets[0], "still-live")
        old_time = START - dt.timedelta(days=367)
        owned = {"managed_by": MANAGED, "backup_series": self.cfg.name}
        protected_key = blob_key(self.cfg.source_buckets[0], source)
        self.api.put_object(self.cfg.bucket, protected_key, storage_class="ARCHIVE", metadata=owned, created=old_time)
        stale = self.api.put_object(self.cfg.bucket, "objects/" + "a" * 64, storage_class="ARCHIVE", metadata=owned, created=old_time)
        recent = self.api.put_object(self.cfg.bucket, "objects/" + "b" * 64, storage_class="ARCHIVE", metadata=owned,
                                     created=START - dt.timedelta(days=365))
        self.run_quiet()
        self.assertNotIn((self.cfg.bucket, stale["name"], stale["generation"]), self.api.objects)
        self.assertIn((self.cfg.bucket, recent["name"], recent["generation"]), self.api.objects)
        self.assertTrue(any(key[1] == protected_key for key in self.api.objects))

    def test_lease_conflict_skips_and_finally_releases(self):
        self.assertTrue(self.runner.acquire())
        other = Runner(self.cfg, self.api, clock=lambda: self.api.now)
        self.assertFalse(other.acquire())
        self.runner.release()
        self.assertTrue(other.acquire())
        other.release()
        self.assertFalse(any(key[1].startswith("locks/") for key in self.api.objects))

    def test_expired_lease_uses_generation_precondition(self):
        self.runner.write_json("locks/example.json", {"owner": "old", "expiresAt": stamp(START - dt.timedelta(seconds=1))})
        self.assertTrue(self.runner.acquire())
        writes = [call for call in self.api.calls if "/upload/" in call[1]]
        self.assertNotEqual(writes[-1][2]["ifGenerationMatch"], 0)
        self.runner.release()

    def test_repeated_page_token_fails_closed(self):
        api = Api()
        with patch.object(api, "request", return_value={"items": [], "nextPageToken": "same"}):
            with self.assertRaisesRegex(BackupError, "REPEATED_PAGE_TOKEN"):
                list(api.pages("unused"))


if __name__ == "__main__":
    unittest.main()
