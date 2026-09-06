#!/usr/bin/env python3
"""Daily incremental disk snapshots and immutable copies of external objects.

Only private BACKUP_CONFIG supplies deployment identifiers. The service account
uses Cloud Run's metadata server; logs deliberately contain no resource names.
"""

import base64
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass


UTC = dt.timezone.utc
MANAGED = "carbon-cold-backup"
COMPUTE = "https://compute.googleapis.com/compute/v1/projects/"
STORAGE = "https://storage.googleapis.com/storage/v1/b/"
UPLOAD = "https://storage.googleapis.com/upload/storage/v1/b/"
MAX_RESPONSE = 64 * 1024 * 1024


class BackupError(Exception):
    """Messages must be fixed codes, never provider payloads or object names."""


class ApiError(BackupError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"API_HTTP_{status}")


def stamp(value):
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def instant(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
        return parsed.astimezone(UTC)
    except (AttributeError, TypeError, ValueError) as exc:
        raise BackupError("INVALID_TIMESTAMP") from exc


def encoded(value):
    return urllib.parse.quote(str(value), safe="")


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def crc32c(data):
    # Castagnoli CRC, matching Cloud Storage's base64 network-byte-order field.
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82F63B78 if crc & 1 else 0)
    return base64.b64encode((crc ^ 0xFFFFFFFF).to_bytes(4, "big")).decode()


@dataclass(frozen=True)
class Config:
    project: str
    zone: str
    disk: str
    name: str
    location: str
    bucket: str
    source_buckets: tuple
    daily_days: int = 90
    monthly_days: int = 366
    monitoring_metric: str = ""

    @classmethod
    def parse(cls, raw):
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError
            if not isinstance(data.get("source_buckets"), list):
                raise ValueError
            data["source_buckets"] = tuple(data["source_buckets"])
            config = cls(**data)
            for key in ("project", "zone", "disk", "name", "location"):
                value = getattr(config, key)
                if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,61}[a-z0-9]|[a-z]", value):
                    raise ValueError
            if len(config.name) > 49 or len(set(config.source_buckets)) != len(config.source_buckets):
                raise ValueError
            for value in (config.bucket, *config.source_buckets):
                if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", value):
                    raise ValueError
            if config.bucket in config.source_buckets or len(config.source_buckets) > 20:
                raise ValueError
            if type(config.daily_days) is not int or not 90 <= config.daily_days <= 3650:
                raise ValueError
            if type(config.monthly_days) is not int or not 366 <= config.monthly_days <= 3650:
                raise ValueError
            if config.monthly_days < config.daily_days:
                raise ValueError
            if config.monitoring_metric and config.monitoring_metric != "custom.googleapis.com/carbon_backup/last_success":
                raise ValueError
            return config
        except (KeyError, TypeError, ValueError) as exc:
            raise BackupError("INVALID_CONFIG") from exc

    @property
    def disk_path(self):
        return f"projects/{self.project}/zones/{self.zone}/disks/{self.disk}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Api:
    def __init__(self):
        self.opener = urllib.request.build_opener(NoRedirect())
        self.token = ""
        self.token_until = 0
        self.deadline = time.monotonic() + 55 * 60

    def check_deadline(self):
        if time.monotonic() >= self.deadline:
            raise BackupError("RUN_TIMEOUT")

    def access_token(self):
        if time.monotonic() >= self.token_until:
            req = urllib.request.Request(
                "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
                headers={"Metadata-Flavor": "Google"},
            )
            try:
                with self.opener.open(req, timeout=10) as response:
                    value = json.loads(response.read(65536))
                self.token = value["access_token"]
                self.token_until = time.monotonic() + int(value["expires_in"]) - 60
            except Exception as exc:
                raise BackupError("METADATA_AUTH_FAILED") from exc
        return self.token

    def request(self, method, url, *, query=None, body=None, raw=None, content_type=None, media=False):
        if not url.startswith((COMPUTE, STORAGE, UPLOAD, "https://monitoring.googleapis.com/v3/projects/")):
            raise BackupError("INVALID_API_ENDPOINT")
        if query:
            url += "?" + urllib.parse.urlencode(query)
        payload = json_bytes(body) if body is not None else raw
        for attempt in range(5):
            self.check_deadline()
            headers = {"Authorization": "Bearer " + self.access_token()}
            if payload is not None:
                headers["Content-Type"] = content_type or "application/json"
            request = urllib.request.Request(url, data=payload, headers=headers, method=method)
            try:
                with self.opener.open(request, timeout=60) as response:
                    data = response.read(MAX_RESPONSE + 1)
                if len(data) > MAX_RESPONSE:
                    raise BackupError("API_RESPONSE_TOO_LARGE")
                return data if media else (json.loads(data) if data else {})
            except urllib.error.HTTPError as exc:
                status = exc.code
                exc.close()
                if status == 401:
                    self.token_until = 0
                elif status not in (408, 429, 500, 502, 503, 504):
                    raise ApiError(status) from None
                if attempt == 4:
                    raise ApiError(status) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                if attempt == 4:
                    raise BackupError("API_NETWORK_FAILED") from exc
            time.sleep(min(2 ** attempt, 16))
        raise BackupError("API_RETRY_EXHAUSTED")

    def pages(self, url, *, query=None):
        params = dict(query or {})
        seen = set()
        while True:
            result = self.request("GET", url, query=params)
            yield from result.get("items", [])
            token = result.get("nextPageToken")
            if not token:
                return
            if token in seen:
                raise BackupError("REPEATED_PAGE_TOKEN")
            seen.add(token)
            params["pageToken"] = token


def object_url(bucket, name):
    return STORAGE + encoded(bucket) + "/o/" + encoded(name)


def get_optional(api, url, **kwargs):
    try:
        return api.request("GET", url, **kwargs)
    except ApiError as exc:
        if exc.status == 404:
            return None
        raise


def checked_object(metadata):
    try:
        if not isinstance(metadata["name"], str) or not metadata["name"]:
            raise ValueError
        if not str(metadata["generation"]).isdigit() or int(metadata["generation"]) <= 0:
            raise ValueError
        if not str(metadata["size"]).isdigit():
            raise ValueError
        if len(base64.b64decode(metadata["crc32c"], validate=True)) != 4:
            raise ValueError
        return metadata
    except (KeyError, TypeError, ValueError) as exc:
        raise BackupError("INVALID_OBJECT_METADATA") from exc


def verify_copy(source, target, config, key):
    checked_object(source)
    checked_object(target)
    if (target["name"] != key or str(target["size"]) != str(source["size"])
            or target["crc32c"] != source["crc32c"] or target.get("storageClass") != "ARCHIVE"
            or target.get("metadata", {}).get("managed_by") != MANAGED
            or target.get("metadata", {}).get("backup_series") != config.name):
        raise BackupError("BACKUP_OBJECT_MISMATCH")
    return target


def blob_key(bucket, metadata):
    return "objects/" + hashlib.sha256(json_bytes([bucket, metadata["name"], str(metadata["generation"])] )).hexdigest()


def select_versions(objects, captured_at):
    cutoff = captured_at - dt.timedelta(seconds=60)
    selected = []
    seen = set()
    for item in objects:
        checked_object(item)
        identity = (item["name"], str(item["generation"]))
        if identity in seen:
            raise BackupError("DUPLICATE_SOURCE_GENERATION")
        seen.add(identity)
        if not item.get("timeDeleted") or instant(item["timeDeleted"]) >= cutoff:
            selected.append(item)
    return selected


class Runner:
    def __init__(self, config, api=None, clock=None, sleep=time.sleep):
        self.config = config
        self.api = api or Api()
        self.clock = clock or (lambda: dt.datetime.now(UTC))
        self.sleep = sleep
        self.snapshots_url = COMPUTE + encoded(config.project) + "/global/snapshots"
        self.lease = None

    def log(self, status, **counts):
        print(json.dumps({"event": "carbon_cold_backup", "status": status, **counts}), flush=True)

    def object_list(self, bucket, **query):
        return self.api.pages(STORAGE + encoded(bucket) + "/o", query={"maxResults": 1000, **query})

    def read_json(self, name):
        metadata = get_optional(self.api, object_url(self.config.bucket, name))
        if metadata is None:
            return None, None
        checked_object(metadata)
        data = self.api.request("GET", object_url(self.config.bucket, name),
                                query={"alt": "media", "generation": metadata["generation"]}, media=True)
        if len(data) != int(metadata["size"]) or crc32c(data) != metadata["crc32c"]:
            raise BackupError("JSON_OBJECT_CHECKSUM_FAILED")
        try:
            return json.loads(data), metadata
        except (ValueError, UnicodeError) as exc:
            raise BackupError("INVALID_JSON_OBJECT") from exc

    def write_json(self, name, value, generation=0):
        data = json_bytes(value)
        boundary = "carbon_" + uuid.uuid4().hex
        metadata = {"name": name, "contentType": "application/json", "storageClass": "STANDARD",
                    "crc32c": crc32c(data), "metadata": {"managed_by": MANAGED, "backup_series": self.config.name}}
        body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode()
                + json_bytes(metadata) + f"\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n".encode()
                + data + f"\r\n--{boundary}--\r\n".encode())
        response = self.api.request("POST", UPLOAD + encoded(self.config.bucket) + "/o",
                                    query={"uploadType": "multipart", "ifGenerationMatch": generation},
                                    raw=body, content_type="multipart/related; boundary=" + boundary)
        checked_object(response)
        if response["crc32c"] != metadata["crc32c"] or int(response["size"]) != len(data):
            raise BackupError("JSON_UPLOAD_CHECKSUM_FAILED")
        return response

    def acquire(self):
        name = f"locks/{self.config.name}.json"
        owner = str(uuid.uuid4())
        for _ in range(3):
            current, metadata = self.read_json(name)
            if current is not None and instant(current.get("expiresAt")) > self.clock():
                return False
            generation = metadata["generation"] if metadata else 0
            value = {"owner": owner, "expiresAt": stamp(self.clock() + dt.timedelta(hours=2))}
            try:
                result = self.write_json(name, value, generation)
                self.lease = (name, result["generation"])
                return True
            except ApiError as exc:
                if exc.status != 412:
                    raise
                existing, meta = self.read_json(name)
                if existing and existing.get("owner") == owner:
                    self.lease = (name, meta["generation"])
                    return True
        return False

    def release(self):
        if self.lease:
            name, generation = self.lease
            try:
                self.api.request("DELETE", object_url(self.config.bucket, name), query={"ifGenerationMatch": generation})
            except ApiError as exc:
                if exc.status not in (404, 412):
                    raise
            finally:
                self.lease = None

    def owned(self, snapshot, disk_id, *, ready=True):
        config = self.config
        labels = snapshot.get("labels", {})
        matched = re.fullmatch(re.escape(config.name) + r"-cold-(\d{8})", snapshot.get("name", ""))
        if not matched or labels.get("managed_by") != MANAGED or labels.get("backup_series") != config.name:
            return False
        if (snapshot.get("sourceDisk", "").removeprefix("https://www.googleapis.com/compute/v1/")
                .removeprefix("https://compute.googleapis.com/compute/v1/") != config.disk_path
                or str(snapshot.get("sourceDiskId")) != str(disk_id)
                or snapshot.get("snapshotType") != "ARCHIVE"
                or snapshot.get("autoCreated") or snapshot.get("sourceSnapshotSchedulePolicy")
                or snapshot.get("storageLocations") != [config.location]):
            return False
        if ready and snapshot.get("status") != "READY":
            return False
        recovery = labels.get("recovery")
        if recovery not in ("daily", "monthly"):
            return False
        try:
            day = dt.datetime.strptime(matched[1], "%Y%m%d").date()
            days = config.monthly_days if recovery == "monthly" else config.daily_days
            if labels.get("expires_on") != (day + dt.timedelta(days=days)).isoformat():
                return False
            instant(snapshot["creationTimestamp"])
        except (KeyError, ValueError, BackupError):
            return False
        return True

    def expired(self, snapshot):
        days = self.config.monthly_days if snapshot["labels"]["recovery"] == "monthly" else self.config.daily_days
        return (self.clock().date().isoformat() >= snapshot["labels"]["expires_on"]
                and self.clock() >= instant(snapshot["creationTimestamp"]) + dt.timedelta(days=days))

    def snapshot_list(self):
        return list(self.api.pages(self.snapshots_url, query={"maxResults": 500}))

    def wait_snapshot(self, name, disk_id):
        deadline = time.monotonic() + 30 * 60
        while time.monotonic() < deadline:
            snapshot = get_optional(self.api, self.snapshots_url + "/" + encoded(name))
            if snapshot is not None:
                if not self.owned(snapshot, disk_id, ready=False):
                    raise BackupError("SNAPSHOT_IDENTITY_MISMATCH")
                if snapshot.get("status") == "READY":
                    return snapshot
                if snapshot.get("status") in ("FAILED", "DELETING"):
                    raise BackupError("SNAPSHOT_NOT_RECOVERABLE")
            self.sleep(10)
        raise BackupError("SNAPSHOT_TIMEOUT")

    def create_snapshot(self, name, disk_id, started, snapshots):
        same = next((item for item in snapshots if item.get("name") == name), None)
        if same:
            return self.wait_snapshot(name, disk_id)
        monthly = True
        for snapshot in snapshots:
            if self.owned(snapshot, disk_id) and snapshot["name"][-8:-2] == name[-8:-2]:
                value, _ = self.read_json(f"manifests/{snapshot['name']}.json")
                if value is not None:
                    self.validate_manifest(value, snapshot)
                    monthly = False
                    break
        recovery = "monthly" if monthly else "daily"
        days = self.config.monthly_days if monthly else self.config.daily_days
        body = {"name": name, "sourceDisk": self.config.disk_path, "snapshotType": "ARCHIVE",
                "storageLocations": [self.config.location], "labels": {
                    "managed_by": MANAGED, "backup_series": self.config.name, "recovery": recovery,
                    "expires_on": (started.date() + dt.timedelta(days=days)).isoformat()}}
        try:
            operation = self.api.request("POST", self.snapshots_url, body=body,
                                         query={"requestId": str(uuid.uuid5(uuid.NAMESPACE_URL, self.config.disk_path + str(disk_id) + name))})
            if operation.get("error"):
                raise BackupError("SNAPSHOT_CREATE_FAILED")
        except ApiError as exc:
            if exc.status != 409:
                raise
        return self.wait_snapshot(name, disk_id)

    def source_versions(self, captured_at):
        result = []
        for bucket in self.config.source_buckets:
            metadata = self.api.request("GET", STORAGE + encoded(bucket))
            if metadata.get("versioning", {}).get("enabled") is not True:
                raise BackupError("SOURCE_VERSIONING_REQUIRED")
            for item in select_versions(self.object_list(bucket, versions="true"), captured_at):
                result.append((bucket, item))
        return result

    def copy_object(self, bucket, source):
        config = self.config
        key = blob_key(bucket, source)
        existing = get_optional(self.api, object_url(config.bucket, key))
        if existing is not None:
            return verify_copy(source, existing, config, key)
        url = (object_url(bucket, source["name"]) + "/rewriteTo/b/" + encoded(config.bucket) + "/o/" + encoded(key))
        query = {"sourceGeneration": str(source["generation"]), "ifGenerationMatch": 0}
        body = {"storageClass": "ARCHIVE", "metadata": {"managed_by": MANAGED, "backup_series": config.name}}
        while True:
            try:
                response = self.api.request("POST", url, query=query, body=body)
            except ApiError as exc:
                if exc.status != 412:
                    raise
                target = get_optional(self.api, object_url(config.bucket, key))
                if target is None:
                    raise BackupError("COPY_PRECONDITION_FAILED") from None
                return verify_copy(source, target, config, key)
            if response.get("done") is True:
                return verify_copy(source, response["resource"], config, key)
            token = response.get("rewriteToken")
            if not token:
                raise BackupError("INVALID_REWRITE_RESPONSE")
            query["rewriteToken"] = token

    def validate_manifest(self, manifest, snapshot, *, current_sources=False):
        config = self.config
        try:
            if (manifest["schemaVersion"] != 1 or manifest["status"] != "COMPLETE"
                    or manifest["backupSeries"] != config.name
                    or not isinstance(manifest["sourceBuckets"], list)
                    or len(set(manifest["sourceBuckets"])) != len(manifest["sourceBuckets"])
                    or (current_sources and manifest["sourceBuckets"] != list(config.source_buckets))
                    or manifest["snapshot"] != self.snapshot_record(snapshot)
                    or type(manifest["objects"]) is not list
                    or len(manifest["objects"]) != manifest["objectCount"]):
                raise ValueError
            if instant(manifest["completedAt"]) < instant(manifest["startedAt"]):
                raise ValueError
            seen = set()
            for entry in manifest["objects"]:
                source, backup = entry["source"], entry["backup"]
                checked_object(source)
                checked_object(backup)
                key = blob_key(source["bucket"], source)
                if source["bucket"] not in manifest["sourceBuckets"] or backup["bucket"] != config.bucket:
                    raise ValueError
                if backup["name"] != key or key in seen or source["crc32c"] != backup["crc32c"] or str(source["size"]) != str(backup["size"]):
                    raise ValueError
                seen.add(key)
        except (KeyError, TypeError, ValueError, BackupError) as exc:
            raise BackupError("INVALID_COMPLETE_MANIFEST") from exc

    def snapshot_record(self, snapshot):
        return {"name": snapshot["name"], "id": str(snapshot["id"]),
                "sourceDisk": self.config.disk_path, "sourceDiskId": str(snapshot["sourceDiskId"]),
                "creationTimestamp": snapshot["creationTimestamp"], "storageLocations": snapshot["storageLocations"],
                "recovery": snapshot["labels"]["recovery"], "expiresOn": snapshot["labels"]["expires_on"]}

    def verify_manifest_copies(self, manifest):
        for entry in manifest["objects"]:
            target = self.api.request("GET", object_url(self.config.bucket, entry["backup"]["name"]),
                                      query={"generation": entry["backup"]["generation"]})
            verify_copy(entry["source"], target, self.config, entry["backup"]["name"])

    def complete_manifest(self, snapshot, started):
        path = f"manifests/{snapshot['name']}.json"
        existing, _ = self.read_json(path)
        if existing is not None:
            self.validate_manifest(existing, snapshot, current_sources=True)
            self.verify_manifest_copies(existing)
            return existing
        objects = []
        for bucket, source in self.source_versions(instant(snapshot["creationTimestamp"])):
            target = self.copy_object(bucket, source)
            fields = ("name", "generation", "size", "crc32c")
            objects.append({"source": {"bucket": bucket, **{key: source[key] for key in fields}},
                            "backup": {"bucket": self.config.bucket, **{key: target[key] for key in fields}}})
        manifest = {"schemaVersion": 1, "status": "COMPLETE", "backupSeries": self.config.name,
                    "snapshot": self.snapshot_record(snapshot), "sourceBuckets": list(self.config.source_buckets),
                    "objects": objects, "objectCount": len(objects), "startedAt": stamp(started),
                    "completedAt": stamp(self.clock())}
        self.validate_manifest(manifest, snapshot, current_sources=True)
        self.verify_manifest_copies(manifest)
        try:
            self.write_json(path, manifest)
        except ApiError as exc:
            if exc.status != 412:
                raise
        saved, _ = self.read_json(path)
        if saved is None:
            raise BackupError("MANIFEST_NOT_SAVED")
        self.validate_manifest(saved, snapshot, current_sources=True)
        self.verify_manifest_copies(saved)
        return saved

    def delete_snapshot(self, snapshot):
        url = self.snapshots_url + "/" + encoded(snapshot["name"])
        current = get_optional(self.api, url)
        if current is None:
            return
        if (current.get("id") != snapshot.get("id") or not self.owned(current, snapshot["sourceDiskId"])
                or self.snapshot_record(current) != self.snapshot_record(snapshot) or not self.expired(current)):
            raise BackupError("PRUNE_SNAPSHOT_CHANGED")
        try:
            self.api.request("DELETE", url, query={"requestId": str(uuid.uuid4())})
        except ApiError as exc:
            if exc.status != 404:
                raise
        deadline = time.monotonic() + 5 * 60
        while time.monotonic() < deadline:
            if get_optional(self.api, url) is None:
                return
            self.sleep(5)
        raise BackupError("SNAPSHOT_DELETE_TIMEOUT")

    def orphan_snapshot(self, manifest, disk_id):
        """Recover retention identity only for an absent current-disk snapshot."""
        try:
            record = manifest["snapshot"]
            snapshot = {"name": record["name"], "id": record["id"],
                        "sourceDisk": record["sourceDisk"], "sourceDiskId": record["sourceDiskId"],
                        "creationTimestamp": record["creationTimestamp"], "storageLocations": record["storageLocations"],
                        "snapshotType": "ARCHIVE", "status": "READY", "labels": {
                            "managed_by": MANAGED, "backup_series": self.config.name,
                            "recovery": record["recovery"], "expires_on": record["expiresOn"]}}
            if not str(snapshot["id"]).isdigit() or not self.owned(snapshot, disk_id):
                raise ValueError
            self.validate_manifest(manifest, snapshot)
            return snapshot
        except (KeyError, TypeError, ValueError, BackupError) as exc:
            raise BackupError("INVALID_ORPHAN_MANIFEST") from exc

    def prune(self, disk_id, successful):
        # Read and validate every manifest before any deletion. Unknown manifests
        # stop collection rather than silently losing their object references.
        all_snapshots = {item["name"]: item for item in self.snapshot_list()}
        snapshots = {name: item for name, item in all_snapshots.items() if self.owned(item, disk_id)}
        manifests = []
        orphan_manifests = []
        manifest_names = set()
        successful_complete = False
        protected = set()
        for metadata in self.object_list(self.config.bucket, prefix="manifests/"):
            value, current = self.read_json(metadata["name"])
            if value is None:
                raise BackupError("MANIFEST_DISAPPEARED")
            name = value.get("snapshot", {}).get("name")
            manifest_names.add(name)
            snapshot = snapshots.get(name)
            if snapshot is not None:
                if metadata["name"] != f"manifests/{name}.json":
                    raise BackupError("MANIFEST_PATH_MISMATCH")
                self.validate_manifest(value, snapshot)
                manifests.append((value, current, snapshot))
                if self.snapshot_record(snapshot) == self.snapshot_record(successful):
                    successful_complete = True
            elif (name not in all_snapshots and value.get("backupSeries") == self.config.name
                  and str(value.get("snapshot", {}).get("sourceDiskId")) == str(disk_id)):
                if metadata["name"] != f"manifests/{name}.json":
                    raise BackupError("MANIFEST_PATH_MISMATCH")
                snapshot = self.orphan_snapshot(value, disk_id)
                orphan_manifests.append((value, current, snapshot))
            else:
                # A previous incarnation of the disk is retained indefinitely.
                # Unknown schema fails closed; it may refer to shared blobs.
                if value.get("schemaVersion") != 1 or value.get("status") != "COMPLETE" or not isinstance(value.get("objects"), list):
                    raise BackupError("UNKNOWN_MANIFEST")
                for entry in value["objects"]:
                    if entry.get("backup", {}).get("bucket") == self.config.bucket:
                        protected.add(entry["backup"]["name"])
        if not successful_complete:
            raise BackupError("NO_COMPLETE_RECOVERY_POINT")
        newest = max(snapshots.values(), key=lambda item: instant(item["creationTimestamp"]), default=successful)
        expired = []
        expired_orphans = []
        for value, metadata, snapshot in manifests + orphan_manifests:
            if snapshot["name"] != newest["name"] and snapshot["name"] != successful["name"] and self.expired(snapshot):
                (expired if snapshot["name"] in snapshots else expired_orphans).append((metadata, snapshot))
            else:
                protected.update(entry["backup"]["name"] for entry in value["objects"])
        expired_partial = [snapshot for name, snapshot in snapshots.items()
                           if name not in manifest_names and name not in (newest["name"], successful["name"])
                           and self.expired(snapshot)]
        # Retain any existing object whose source could currently be referenced.
        protected.update(blob_key(bucket, item) for bucket, item in self.source_versions(self.clock()))
        deleted_snapshots = 0
        for metadata, snapshot in expired:
            self.delete_snapshot(snapshot)
            self.api.request("DELETE", object_url(self.config.bucket, metadata["name"]),
                             query={"ifGenerationMatch": metadata["generation"]})
            deleted_snapshots += 1
        for snapshot in expired_partial:
            self.delete_snapshot(snapshot)
            deleted_snapshots += 1
        for metadata, snapshot in expired_orphans:
            if get_optional(self.api, self.snapshots_url + "/" + encoded(snapshot["name"])) is not None:
                raise BackupError("PRUNE_SNAPSHOT_CHANGED")
            self.api.request("DELETE", object_url(self.config.bucket, metadata["name"]),
                             query={"ifGenerationMatch": metadata["generation"]})
        deleted_objects = 0
        for metadata in self.object_list(self.config.bucket, prefix="objects/"):
            labels = metadata.get("metadata", {})
            if (not re.fullmatch(r"objects/[0-9a-f]{64}", metadata.get("name", ""))
                    or labels.get("managed_by") != MANAGED or labels.get("backup_series") != self.config.name
                    or metadata["name"] in protected or metadata.get("storageClass") != "ARCHIVE"):
                continue
            if self.clock() < instant(metadata["timeCreated"]) + dt.timedelta(days=366):
                continue
            self.api.request("DELETE", object_url(self.config.bucket, metadata["name"]),
                             query={"ifGenerationMatch": metadata["generation"]})
            deleted_objects += 1
        return deleted_snapshots, deleted_objects

    def heartbeat(self):
        metric = self.config.monitoring_metric
        if metric:
            now = self.clock()
            self.api.request("POST", "https://monitoring.googleapis.com/v3/projects/" + encoded(self.config.project) + "/timeSeries",
                             body={"timeSeries": [{"metric": {"type": metric, "labels": {"series": self.config.name}},
                                 "resource": {"type": "global", "labels": {"project_id": self.config.project}},
                                 "metricKind": "GAUGE", "valueType": "INT64", "points": [{
                                     "interval": {"endTime": stamp(now)}, "value": {"int64Value": str(int(now.timestamp()))}}]}]})

    def run(self):
        started = self.clock()
        if not self.acquire():
            self.log("busy")
            return {"status": "busy"}
        try:
            self.log("running", stage="snapshot")
            disk = self.api.request("GET", COMPUTE + self.config.disk_path.removeprefix("projects/"))
            disk_id = str(disk["id"])
            name = self.config.name + "-cold-" + started.strftime("%Y%m%d")
            snapshot = self.create_snapshot(name, disk_id, started, self.snapshot_list())
            self.log("running", stage="files")
            manifest = self.complete_manifest(snapshot, started)
            self.log("running", stage="retention")
            deleted_snapshots, deleted_objects = self.prune(disk_id, snapshot)
            self.heartbeat()
            self.log("success", objects=manifest["objectCount"], deleted_snapshots=deleted_snapshots, deleted_objects=deleted_objects)
            return {"status": "success", "objects": manifest["objectCount"]}
        finally:
            self.release()


def main():
    try:
        Runner(Config.parse(os.environ.get("BACKUP_CONFIG", ""))).run()
    except Exception as exc:
        code = str(exc) if isinstance(exc, BackupError) else "UNEXPECTED_BACKUP_FAILURE"
        print(json.dumps({"event": "carbon_cold_backup", "status": "failed", "code": code}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
