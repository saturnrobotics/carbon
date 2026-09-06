#!/usr/bin/env python3
"""Provision managed cold backups from the laptop; configuration stays private."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from deploy import private_json  # noqa: E402


def configuration(deployment, options):
    allowed = {"location", "source_buckets", "daily_days", "monthly_days", "alert_email"}
    if set(options) - allowed:
        raise ValueError("Unknown backups.json keys; see backups/config.example.json")
    location = options.get("location", deployment["REGION"])
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]+", location):
        raise ValueError("Backup location must be a GCP region")
    for key, expected in (("daily_days", 90), ("monthly_days", 366)):
        if options.get(key, expected) != expected:
            raise ValueError("This backup policy requires 90 daily days and 366 monthly days")
    sources = options.get("source_buckets", [])
    if not isinstance(sources, list) or any(not isinstance(b, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", b) for b in sources) or len(set(sources)) != len(sources):
        raise ValueError("source_buckets must list distinct GCS bucket names")
    email = options.get("alert_email", "")
    if not isinstance(email, str) or (email and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)):
        raise ValueError("Invalid backup alert email")
    result = {"project": deployment["PROJECT_ID"], "zone": deployment["ZONE"],
              "disk": deployment["VM_NAME"] + "-data", "name": deployment["VM_NAME"],
              "location": location, "bucket": deployment["PROJECT_ID"] + "-" + deployment["VM_NAME"] + "-cold-backups",
              "source_buckets": sources, "daily_days": 90, "monthly_days": 366,
              "monitoring_metric": "custom.googleapis.com/carbon_backup/last_success"}
    if result["bucket"] in sources:
        raise ValueError("The backup bucket cannot also be a source")
    from backups.runner import BackupError, Config
    try:
        Config.parse(json.dumps(result))
    except BackupError:
        raise ValueError("Backup configuration does not satisfy worker limits") from None
    return result


class Provisioner:
    def __init__(self, config, private_dir):
        self.c = config
        self.private_dir = private_dir
        self.log = private_dir / "backups-setup.log"
        self.log.touch(mode=0o600)
        self.log.chmod(0o600)
        self.token = ""
        self.token_time = 0

    def command(self, *args, json_output=False):
        result = subprocess.run(["gcloud", *args, "--project", self.c["project"], "--quiet"], text=True, capture_output=True)
        with self.log.open("a") as log:
            log.write(result.stdout + result.stderr)
        if result.returncode:
            raise ValueError("Backup provisioning command failed; inspect private backups-setup.log")
        return json.loads(result.stdout) if json_output else result.stdout

    def api(self, url, method="GET", data=None, missing=False):
        if time.monotonic() - self.token_time > 1800 or not self.token:
            self.token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
            self.token_time = time.monotonic()
        for attempt in range(5):
            req = urllib.request.Request(url, method=method,
                data=json.dumps(data).encode() if data is not None else None,
                headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=60) as response:
                    content = response.read()
                    return json.loads(content) if content else {}
            except urllib.error.HTTPError as error:
                if missing and error.code == 404:
                    error.close()
                    return None
                if error.code in (429, 500, 502, 503, 504) and attempt < 4:
                    error.close()
                    time.sleep(2 ** attempt)
                    continue
                with self.log.open("a") as log:
                    log.write(error.read().decode(errors="replace") + "\n")
                error.close()
                raise ValueError(f"Backup provisioning API failed (HTTP {error.code}); inspect private backups-setup.log") from None

    def role(self, suffix, permissions):
        role_id = self.c["name"].replace("-", "_") + "_backup_" + suffix
        parent = "https://iam.googleapis.com/v1/projects/" + self.c["project"]
        url = parent + "/roles/" + role_id
        existing = self.api(url, missing=True)
        role = {"title": "Carbon backup " + suffix, "description": "Managed by the private deployment backup provisioner", "includedPermissions": permissions, "stage": "GA"}
        if existing is None:
            self.api(parent + "/roles", "POST", {"roleId": role_id, "role": role})
        elif sorted(existing["includedPermissions"]) != sorted(permissions):
            self.api(url + "?updateMask=includedPermissions", "PATCH", {"includedPermissions": permissions})
        return f'projects/{self.c["project"]}/roles/{role_id}'

    def account(self, suffix):
        project = self.c["project"]
        name = self.c["name"] + "-backup-" + suffix
        if len(name) > 30:
            name = name[:21] + "-" + hashlib.sha256(name.encode()).hexdigest()[:8]
        email = f"{name}@{project}.iam.gserviceaccount.com"
        parent = f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts"
        if self.api(parent + "/" + email, missing=True) is None:
            self.api(parent, "POST", {"accountId": name, "serviceAccount": {"displayName": "Carbon backup " + suffix}})
        return email

    def bucket(self, name, storage_class):
        url = "https://storage.googleapis.com/storage/v1/b/" + name
        existing = self.api(url, missing=True)
        if existing is None:
            existing = self.api("https://storage.googleapis.com/storage/v1/b?project=" + self.c["project"], "POST", {
                "name": name, "location": self.c["location"], "storageClass": storage_class,
                "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}, "publicAccessPrevention": "enforced"},
                "softDeletePolicy": {"retentionDurationSeconds": "604800"},
                "labels": {"managed-by": "carbon-cold-backup"}})
        project = self.api("https://cloudresourcemanager.googleapis.com/v1/projects/" + self.c["project"])
        if str(existing["projectNumber"]) != str(project["projectNumber"]) or existing.get("labels", {}).get("managed-by") != "carbon-cold-backup":
            raise ValueError("Refusing to adopt an unrelated backup/build bucket")
        if existing["location"].lower() != self.c["location"]:
            raise ValueError("Existing backup bucket location differs from configuration")
        self.api(url, "PATCH", {"storageClass": storage_class, "iamConfiguration": {
            "uniformBucketLevelAccess": {"enabled": True}, "publicAccessPrevention": "enforced"}})

    def bind_project(self, account, role, condition=None):
        flags = ["--condition", condition] if condition else ["--condition=None"]
        self.command("projects", "add-iam-policy-binding", self.c["project"], "--member", "serviceAccount:" + account, "--role", role, *flags)

    def bind_bucket(self, bucket, account, role):
        self.command("storage", "buckets", "add-iam-policy-binding", "gs://" + bucket,
                     "--member", "serviceAccount:" + account, "--role", role)

    def provision(self, alert_email=""):
        c, project, region, name = self.c, self.c["project"], self.c["location"], self.c["name"]
        print("Configuring private backup storage and service accounts.", flush=True)
        self.command("services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "cloudscheduler.googleapis.com", "monitoring.googleapis.com", "logging.googleapis.com", "iam.googleapis.com", "storage.googleapis.com")
        job, repository = name + "-cold-backup", name + "-backups"
        repos_url = f"https://artifactregistry.googleapis.com/v1/projects/{project}/locations/{region}/repositories"
        existing_repository = self.api(repos_url + "/" + repository, missing=True)
        existing_job = self.api(f"https://run.googleapis.com/v2/projects/{project}/locations/{region}/jobs/{job}", missing=True)
        schedules = self.command("scheduler", "jobs", "list", "--location", region, "--format=json", json_output=True)
        schedule = next((item for item in schedules if item["name"].endswith("/" + job)), None)
        for existing in (existing_repository, existing_job):
            if existing and existing.get("labels", {}).get("managed-by") != "carbon-cold-backup":
                raise ValueError("Refusing to adopt an unrelated backup job or image repository")
        if schedule and schedule.get("description") != "Managed by Carbon cold backups":
            raise ValueError("Refusing to adopt an unrelated backup schedule")
        worker, scheduler, builder = (self.account(suffix) for suffix in ("worker", "schedule", "build"))
        self.bucket(c["bucket"], "ARCHIVE")
        staging_bucket = project + "-" + name + "-backup-builds"
        self.bucket(staging_bucket, "STANDARD")
        self.api("https://storage.googleapis.com/storage/v1/b/" + staging_bucket, "PATCH", {
            "lifecycle": {"rule": [{"action": {"type": "Delete"}, "condition": {"age": 7}}]}})
        for bucket in c["source_buckets"]:
            metadata = self.api("https://storage.googleapis.com/storage/v1/b/" + bucket)
            if not metadata.get("versioning", {}).get("enabled"):
                raise ValueError("Enable versioning on each external source bucket before enabling backups")
            # Predefined roles can be bound across projects; a project custom
            # role cannot be attached to another project's attachment bucket.
            self.bind_bucket(bucket, worker, "roles/storage.legacyBucketReader")
            self.bind_bucket(bucket, worker, "roles/storage.objectViewer")
        self.bind_bucket(c["bucket"], worker, self.role("destination", ["storage.buckets.get", "storage.objects.get", "storage.objects.list", "storage.objects.create", "storage.objects.delete"]))
        disk_role = self.role("disk", ["compute.disks.get", "compute.disks.createSnapshot"])
        self.command("compute", "disks", "add-iam-policy-binding", c["disk"], "--zone", c["zone"], "--member", "serviceAccount:" + worker, "--role", disk_role)
        self.bind_project(worker, self.role("create", ["compute.snapshots.create", "compute.snapshots.list", "monitoring.timeSeries.create"]))
        snapshot_role = self.role("snapshots", ["compute.snapshots.get", "compute.snapshots.delete", "compute.snapshots.setLabels"])
        condition = f"expression=resource.name.startsWith('projects/{project}/global/snapshots/{name}-cold-'),title=managed_cold_snapshots"
        self.bind_project(worker, snapshot_role, condition)
        self.bind_project(builder, "roles/logging.logWriter")
        self.bind_bucket(staging_bucket, builder, "roles/storage.objectViewer")
        if existing_repository is None:
            self.command("artifacts", "repositories", "create", repository, "--location", region, "--repository-format=docker", "--labels=managed-by=carbon-cold-backup")
        self.command("artifacts", "repositories", "add-iam-policy-binding", repository, "--location", region, "--member", "serviceAccount:" + builder, "--role=roles/artifactregistry.writer")
        digest = hashlib.sha256(b"".join((HERE / f).read_bytes() for f in ("Dockerfile", "runner.py"))).hexdigest()
        image = f"{region}-docker.pkg.dev/{project}/{repository}/runner:{digest}"
        tags = self.api(repos_url + "/" + repository + "/packages/runner/tags/" + digest, missing=True)
        if tags is None:
            print("Building the backup worker image in GCP.", flush=True)
            with tempfile.TemporaryDirectory(prefix="backup-build-", dir=self.private_dir) as directory:
                directory = Path(directory)
                for filename in ("Dockerfile", "runner.py"):
                    (directory / filename).write_bytes((HERE / filename).read_bytes())
                build = {"steps": [{"name": "gcr.io/cloud-builders/docker", "args": ["build", "-t", image, "."]}], "images": [image], "options": {"logging": "CLOUD_LOGGING_ONLY"}, "serviceAccount": f"projects/{project}/serviceAccounts/{builder}"}
                build_file = directory / "build.json"
                build_file.write_text(json.dumps(build))
                self.command("builds", "submit", str(directory), "--region", region, "--config", str(build_file), "--gcs-source-staging-dir", "gs://" + staging_bucket + "/source")
        with tempfile.TemporaryDirectory(prefix="backup-env-", dir=self.private_dir) as directory:
            environment = Path(directory) / "env.json"
            environment.write_text(json.dumps({"BACKUP_CONFIG": json.dumps(c)}))
            environment.chmod(0o600)
            self.command("run", "jobs", "deploy", job, "--region", region, "--image", image, "--service-account", worker,
                         "--tasks=1", "--parallelism=1", "--max-retries=1", "--task-timeout=3600s", "--cpu=1", "--memory=512Mi", "--env-vars-file", str(environment),
                         "--labels=managed-by=carbon-cold-backup")
        self.command("run", "jobs", "add-iam-policy-binding", job, "--region", region, "--member", "serviceAccount:" + scheduler, "--role=roles/run.invoker")
        exists = schedule is not None
        self.command("scheduler", "jobs", "update" if exists else "create", "http", job, "--location", region,
                     "--description=Managed by Carbon cold backups", "--schedule=0 5 * * *", "--time-zone=Etc/UTC", "--uri", f"https://run.googleapis.com/v2/projects/{project}/locations/{region}/jobs/{job}:run",
                     "--http-method=POST", "--oauth-service-account-email", scheduler, "--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform",
                     "--message-body={}", "--attempt-deadline=180s", "--max-retry-attempts=3", "--min-backoff=300s", "--max-backoff=1800s")
        if exists and next(item for item in schedules if item["name"].endswith("/" + job))["state"] == "PAUSED":
            self.command("scheduler", "jobs", "resume", job, "--location", region)
        self.monitoring(alert_email, job)
        receipt = self.private_dir / "backups-resources.json"
        receipt.write_text(json.dumps({"config": c, "job": job, "scheduler": job, "image": image, "worker": worker}, indent=2) + "\n")
        receipt.chmod(0o600)
        print("Daily cold backups are scheduled for 05:00 UTC; 90 days daily and 366 days monthly.", flush=True)

    def monitoring(self, email, job):
        c = self.c
        parent = "https://monitoring.googleapis.com/v3/projects/" + c["project"]
        metric = c["monitoring_metric"]
        url = parent + "/metricDescriptors/" + urllib.parse.quote(metric, safe="/")
        if self.api(url, missing=True) is None:
            self.api(parent + "/metricDescriptors", "POST", {"type": metric, "metricKind": "GAUGE", "valueType": "INT64", "unit": "s", "displayName": "Last complete cold backup", "labels": [{"key": "series", "valueType": "STRING"}]})
        channels = []
        if email:
            existing = self.api(parent + "/notificationChannels").get("notificationChannels", [])
            channel = next((v for v in existing if v["type"] == "email" and v.get("labels", {}).get("email_address") == email), None)
            if channel is None:
                channel = self.api(parent + "/notificationChannels", "POST", {"type": "email", "displayName": "Cold backup alerts", "labels": {"email_address": email}, "enabled": True})
            channels = [channel["name"]]
        # Native absence caps at 23.5h; custom metrics in PromQL cap lookback at
        # 25h. A 23h absence held for another 7h alerts at 30h after success.
        policy = {"displayName": c["name"] + " cold backup overdue", "combiner": "OR", "enabled": True,
            "notificationChannels": channels, "alertStrategy": {"autoClose": "604800s"},
            "documentation": {"mimeType": "text/markdown", "content": "No complete cold backup for 30 hours. Check the Cloud Run backup job execution logs and Scheduler state. A started snapshot alone is not a complete recovery point. See the private backup recovery runbook."},
            "conditions": [{"displayName": "No successful backup heartbeat for 30 hours", "conditionPrometheusQueryLanguage": {
                "query": f'absent_over_time(custom_googleapis_com:carbon_backup_last_success{{monitored_resource="global",project_id="{c["project"]}",series="{c["name"]}"}}[23h])',
                "duration": "25200s", "evaluationInterval": "300s"}}]}
        failure = {**policy, "displayName": c["name"] + " cold backup failed",
            "conditions": [{"displayName": "Backup execution failed", "conditionThreshold": {
                    "filter": f'metric.type="run.googleapis.com/job/completed_execution_count" AND resource.type="cloud_run_job" AND resource.labels.job_name="{job}" AND metric.labels.result="failed"',
                    "comparison": "COMPARISON_GT", "thresholdValue": 0, "duration": "0s", "aggregations": [{"alignmentPeriod": "3600s", "perSeriesAligner": "ALIGN_SUM"}], "trigger": {"count": 1}}}]}
        existing = self.api(parent + "/alertPolicies").get("alertPolicies", [])
        for desired in (policy, failure):
            found = next((v for v in existing if v["displayName"] == desired["displayName"]), None)
            if found:
                desired["name"] = found["name"]
                self.api("https://monitoring.googleapis.com/v3/" + found["name"], "PATCH", desired)
            else:
                self.api(parent + "/alertPolicies", "POST", desired)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=HERE.parent / ".local/config.json")
    parser.add_argument("--backup-config", type=Path, default=HERE.parent / ".local/backups.json")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--run-now", action="store_true")
    args = parser.parse_args()
    deployment, options = private_json(args.config), private_json(args.backup_config)
    config = configuration(deployment, options)
    if not args.apply:
        print("Backup configuration valid. No cloud requests or changes made.")
        return
    provisioner = Provisioner(config, args.backup_config.resolve().parent)
    provisioner.provision(options.get("alert_email", ""))
    if args.run_now:
        print("Running and verifying the first backup execution.", flush=True)
        provisioner.command("run", "jobs", "execute", config["name"] + "-cold-backup", "--region", config["location"], "--wait")
        print("Backup execution succeeded. Recovery verification is a separate step.")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print("Error:", str(error) if isinstance(error, ValueError) else type(error).__name__ + ": inspect private backup logs", file=sys.stderr)
        sys.exit(1)
