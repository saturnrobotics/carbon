#!/usr/bin/env python3
"""Build and release manual-v1 from a reviewed integration commit."""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timedelta, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

import release

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def read_config(path: Path) -> dict:
    if not path.is_file():
        legacy = HERE.parent / "knowledge/.local/deploy.json"
        if path == HERE / ".local/deploy.json" and legacy.is_file():
            raise ValueError(
                "Existing legacy deployment configuration needs a reviewed Portal cutover. "
                "Keep it private and intact; create Portal configuration from the current "
                "example with fresh foundation outputs. See contrib/deploying/portal/README.md."
            )
        raise ValueError(
            "Portal deployment is not configured. Copy "
            "contrib/deploying/portal/deploy.example.json to "
            "contrib/deploying/portal/.local/deploy.json and complete the "
            "one-time setup in contrib/deploying/portal/README.md."
        )
    return json.loads(path.read_text())


ORDER = ("portal-schema", "portal-parser", "portal-query", "portal-ingest", "portal-retention", "portal-web")


def save_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def prepare_plan(config: dict, source: str, foundation: dict, migrations: list[str]) -> dict:
    services = copy.deepcopy(config["services"])
    for name, spec in services.items():
        spec["kind"] = release.UNITS[name]
        spec["implementation_ready"] = True
        if name == "portal-query" and config.get("redis_ca_secret"):
            spec["redis_ca_secret"] = config["redis_ca_secret"]
        # Filled with a registry receipt before any mutation. These placeholders
        # let the existing strict validator check all runtime inputs pre-build.
        spec["image"] = "example.invalid/validation@sha256:" + "0" * 64
        if name in release.DATABASE_UNITS:
            if config.get("database_ca_secret"):
                spec["database_ca_secret"] = config["database_ca_secret"]
            spec["migrations"] = {
                "minimum": migrations[0] if name == "portal-schema" else migrations[-1],
                "maximum": migrations[-1],
            }
    candidate = {"schema_version": 1, "source_commit": source, "expected_generation": 0,
                 "generation": 1, "services": services, "deploy": {}, "build_receipt": {}}
    release.apply_foundation_audiences(candidate, foundation)
    release.validate_plan(candidate)
    libraries = {release.canonical_digest(json.loads(spec["environment"]["PORTAL_MANUAL_SOURCE_JSON"]))
                 for spec in services.values() if "PORTAL_MANUAL_SOURCE_JSON" in spec["environment"]}
    if len(libraries) > 1:
        raise ValueError("Web, query and ingestion must use the same manual library")
    return candidate


def archive_source(root: Path, revision: str, destination: Path) -> None:
    # Git's archive is the build context, not the developer's directory. A local
    # .env, private deployment input or uncommitted edit cannot enter the image.
    subprocess.run(["git", "-C", str(root), "archive", "--format=tar", "--output", str(destination), revision], check=True, capture_output=True)


def check_ledger(observation: dict, migration_names: list[str]) -> list[str]:
    release.ledger_head(observation)
    applied = sorted(name.removesuffix(".sql") for name in observation["names"])
    if applied != migration_names[:len(applied)]:
        raise ValueError("Live schema is not a prefix of this revision's migrations; review the target and migration history")
    return applied


def release_units(candidate: dict, manifest: Path, *, project: str, region: str, adapter, read_ledger, migration_names: list[str]) -> None:
    observation = read_ledger()
    applied = check_ledger(observation, migration_names)
    for name in ORDER:
        current = json.loads(manifest.read_text()) if manifest.exists() else {"generation": 0, "services": {}}
        spec = candidate["services"][name]
        if current["services"].get(name, {}).get("revision_digest") != release.revision_digest(spec):
            selected = {**candidate, "deploy": {name: ["image or runtime configuration changed"]},
                        "expected_generation": current["generation"], "generation": current["generation"] + 1}
            print(f"Portal: releasing {name}", flush=True)
            release.promote(selected, current, project=project, region=region, manifest=manifest, adapter=adapter, ledger=observation)
        if name == "portal-schema" and applied != migration_names:
            print("Portal: applying pending migrations", flush=True)
            adapter.call(["gcloud", "run", "jobs", "execute", name, "--project", project, "--region", region, "--wait", "--quiet"])
            observation = read_ledger()
            applied = check_ledger(observation, migration_names)
            if applied != migration_names:
                raise ValueError("Schema job finished but the live ledger is not current; application promotion stopped")


class Commands:
    """Keep provider output and command arguments out of the public terminal."""
    def __init__(self, log: Path):
        self.log = log
        log.touch(mode=0o600)
        log.chmod(0o600)

    def call(self, args: list[str], *, capture=False, input_path=None) -> str:
        with self.log.open("a") as log:
            log.write("Running " + args[0] + "\n")
            log.flush()
            stream = input_path.open("rb") if input_path else None
            try:
                result = subprocess.run(args, check=False, text=True, stdin=stream,
                                        stdout=subprocess.PIPE if capture else log, stderr=log, cwd=ROOT)
            finally:
                if stream:
                    stream.close()
            if capture:
                log.write(result.stdout)
            if result.returncode:
                # release.py catches this type to recover a failed rollout. Do
                # not attach provider bodies or potentially private arguments.
                raise subprocess.CalledProcessError(result.returncode, [args[0]])
            return result.stdout if capture else ""


def validate_config(config: dict) -> None:
    if "<" in json.dumps(config) or "REPLACE_ME" in json.dumps(config):
        raise ValueError("Replace every placeholder in the private deploy.json before deploying")
    expected = {"schema_version", "project", "region", "source_repo_url", "image_repository", "pg_service", "database_ca_secret", "services"}
    if not isinstance(config, dict) or set(config) - {"redis_ca_secret"} != expected or config["schema_version"] != 1:
        raise ValueError("deploy.json must use the exact fields in deploy.example.json")
    patterns = {"project": r"[a-z][a-z0-9-]{4,28}[a-z0-9]", "region": r"[a-z]+-[a-z]+[0-9]",
                "pg_service": r"[A-Za-z0-9_-]+", "source_repo_url": r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"}
    for key, pattern in patterns.items():
        if not isinstance(config[key], str) or not re.fullmatch(pattern, config[key]):
            raise ValueError(f"Invalid {key} in private deployment configuration")
    if not isinstance(config["database_ca_secret"], str) or not release.PINNED_SECRET.fullmatch(config["database_ca_secret"]) or not config["database_ca_secret"].startswith(f"projects/{config['project']}/secrets/"):
        raise ValueError("database_ca_secret must be a pinned Secret Manager reference in the selected project")
    if "redis_ca_secret" in config and (not isinstance(config["redis_ca_secret"], str) or not release.PINNED_SECRET.fullmatch(config["redis_ca_secret"]) or not config["redis_ca_secret"].startswith(f"projects/{config['project']}/secrets/")):
        raise ValueError("Redis CA must be a pinned Secret Manager reference in the selected project")
    prefix = f"{config['region']}-docker.pkg.dev/{config['project']}/"
    if not isinstance(config["image_repository"], str) or not config["image_repository"].startswith(prefix) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", config["image_repository"][len(prefix):]):
        raise ValueError("image_repository must belong to the selected project and region")
    if not isinstance(config["services"], dict) or set(config["services"]) != set(ORDER):
        raise ValueError("Configure all six manual-v1 units in services")
    for name, spec in config["services"].items():
        if not isinstance(spec, dict) or set(spec) != {"service_account", "environment", "secrets", "resources", "max_instances", "concurrency", "network", "subnetwork", "egress"}:
            raise ValueError(f"{name} must use the exact runtime fields in deploy.example.json")
        if not isinstance(spec["service_account"], str) or not spec["service_account"].endswith(f"@{config['project']}.iam.gserviceaccount.com"):
            raise ValueError(f"{name} workload identity must belong to the selected project")
        if not isinstance(spec["secrets"], dict) or any(not isinstance(value, str) or not value.startswith(f"projects/{config['project']}/secrets/") for value in spec["secrets"].values()):
            raise ValueError(f"{name} requires secret references in the selected project")
        if not isinstance(spec["environment"], dict) or any(not isinstance(value, str) or not value.strip() for value in spec["environment"].values()):
            raise ValueError(f"{name} environment values must be nonempty strings")
        if not isinstance(spec["resources"], dict) or set(spec["resources"]) != {"cpu", "memory"} or any(not isinstance(value, str) or not value for value in spec["resources"].values()):
            raise ValueError(f"{name} requires CPU and memory limits")


def build_images(candidate: dict, repository: str, state: Path, archive: Path, adapter) -> None:
    path = state / "build-receipts.json"
    stored = json.loads(path.read_text()) if path.exists() else {}
    source = candidate["source_commit"]
    key = repository + "@" + source
    receipts = stored.setdefault(key, {})
    for name, spec in candidate["services"].items():
        unit = name.removeprefix("portal-")
        receipt = receipts.get(name)
        if receipt:
            if receipt.get("source_commit") != source or not release.IMAGE.fullmatch(receipt.get("image", "")) or not receipt["image"].startswith(repository + "/" + unit + "@") or receipt.get("image_digest") != receipt["image"].rsplit("@", 1)[-1]:
                raise ValueError("Stored build receipt is invalid; review the private build evidence")
            adapter.call(["gcloud", "artifacts", "docker", "images", "describe", receipt["image"], "--format=json"], capture=True)
        else:
            print(f"Portal: building and publishing {name} (linux/amd64)", flush=True)
            metadata = state / (unit + "-build.json")
            metadata.unlink(missing_ok=True)
            # Unique immutable tag permits rebuilding a failed attempt without
            # attempting to overwrite an existing Artifact Registry tag.
            tag = repository + "/" + unit + ":" + source + "-" + uuid4().hex[:12]
            adapter.call(["docker", "buildx", "build", "--platform", "linux/amd64", "--target", "runtime",
                          "--file", f"contrib/deploying/portal/Dockerfile.{unit}", "--tag", tag,
                          "--metadata-file", str(metadata), "--push", "-"], input_path=archive)
            digest = json.loads(metadata.read_text()).get("containerimage.digest", "")
            if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
                raise ValueError(f"{name} build did not return an immutable registry digest")
            receipt = {"image": repository + "/" + unit + "@" + digest, "image_digest": digest, "source_commit": source}
            adapter.call(["gcloud", "artifacts", "docker", "images", "describe", receipt["image"], "--format=json"], capture=True)
            receipts[name] = receipt
            save_json(path, stored)
        spec["image"] = receipt["image"]
        candidate["build_receipt"][name] = receipt


def live_ledger(config: dict, adapter) -> dict:
    args = ["psql", "-X", "--no-password", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align", "service=" + config["pg_service"]]
    # Historical migration names and checksums remain immutable. Before the
    # forward rename the same ledger lives under its original schema name.
    ledgers = []
    for schema in ("portal_migrations", "knowledge_migrations"):
        exists = adapter.call([*args, "--command", f"SELECT to_regclass('{schema}.ledger') IS NOT NULL"], capture=True).strip()
        if exists not in {"t", "f"}:
            raise ValueError("Could not observe the live Portal migration ledger")
        if exists == "t":
            ledgers.append(schema)
    if len(ledgers) > 1:
        raise ValueError("Both legacy and Portal migration ledgers exist; review the database before deploying")
    if not ledgers:
        return {"schema_version": 1, "names": []}
    sql = "SELECT json_build_object('schema_version', 1, 'names', coalesce(json_agg(name ORDER BY name), '[]'::json)) FROM " + ledgers[0] + ".ledger"
    return json.loads(adapter.call([*args, "--command", sql], capture=True))


def require_public_schema(config: dict, adapter) -> None:
    # Catalog observation needs no application-schema USAGE or function EXECUTE.
    # The bootstrap observer holds only migration-ledger read access.
    # Built-in pg_catalog.text has the stable type OID 25.
    marker = ("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p "
              "JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace "
              "WHERE n.nspname = 'public' AND p.proname = 'portal_resolve_workforce_identity' "
              "AND p.pronargs = 3 AND p.proargtypes = '25 25 25'::pg_catalog.oidvector AND p.prokind = 'f')")
    present = adapter.call(["psql", "-X", "--no-password", "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align",
                            "service=" + config["pg_service"], "--command", marker], capture=True).strip()
    if present != "t":
        raise ValueError("Apply the Carbon Portal public-identifiers migration before deploying Portal")


def source_revision(config: dict, adapter) -> str:
    git = ["git", "-C", str(ROOT)]
    if adapter.call([*git, "branch", "--show-current"], capture=True).strip() != "saturn/main":
        raise ValueError("Run deployment from reviewed saturn/main after merging the feature PR")
    if adapter.call([*git, "status", "--porcelain"], capture=True).strip():
        raise ValueError("Review and commit working changes before deploying")
    for operation in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"):
        path = adapter.call([*git, "rev-parse", "--git-path", operation], capture=True).strip()
        if (ROOT / path).exists():
            raise ValueError("Finish the active Git operation before deploying")
    revision = adapter.call([*git, "rev-parse", "HEAD"], capture=True).strip()
    published = adapter.call([*git, "ls-remote", config["source_repo_url"], "refs/heads/saturn/main"], capture=True).split()
    if not published or published[0] != revision:
        raise ValueError("Local saturn/main must match the published integration branch; merge/push and wait for CI first")
    module_spec = importlib.util.spec_from_file_location("portal_verify_source", HERE.parent / "gcp-tailscale/verify_source.py")
    verify = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(verify)
    # Reuse the strict workflow verifier through gh's authenticated, fixed-host
    # transport instead of depending on Python's platform certificate store.
    verify.github_json = lambda path: json.loads(adapter.call(["gh", "api", "--hostname", "github.com", path], capture=True))
    adapter.call(["curl", "-q", "--fail", "--silent", "--show-error", "--location", "--max-time", "60",
                  "--output", os.devnull, config["source_repo_url"] + "/archive/" + revision + ".tar.gz"])
    verify.require_verified(config["source_repo_url"], revision, required=(*verify.REQUIRED_CHECKS,
                            (".github/workflows/portal-check.yml", ("foundation", "runtime"))))
    return revision


def observe_units(config: dict, current: dict, adapter) -> None:
    documents = {}
    # List failures are fatal. Do not interpret an IAM/network error from a
    # describe command as a missing service and then try to overwrite it.
    for kind in ("services", "jobs"):
        items = json.loads(adapter.call(["gcloud", "run", kind, "list", "--project", config["project"], "--region", config["region"], "--format=json"], capture=True))
        for document in items:
            name = document.get("metadata", {}).get("name")
            if isinstance(name, str) and name.startswith("knowledge-"):
                raise ValueError("Legacy platform workloads still exist in this project; use a separate Portal foundation and review the cutover")
            if name in ORDER:
                documents[name] = document
    for name in ORDER:
        document = documents.get(name)
        previous = current.get("services", {}).get(name)
        if previous:
            if document is None or release.observed_digest(name, document) != previous["revision_digest"]:
                raise ValueError(f"Live release state differs for {name}; review drift before deployment")
        elif document is not None:
            if name != "portal-web" or release.observed_digest(name, document):
                raise ValueError(f"Existing {name} has no local release receipt; restore its manifest before deploying")
        if name == "portal-web":
            release.foundation_service_annotations(name, document)


def scheduler_command(action: str, job: str) -> list[str]:
    parts = job.split("/")
    if len(parts) != 6 or parts[0] != "projects" or parts[2] != "locations" or parts[4] != "jobs":
        raise ValueError("Invalid Portal scheduler job resource")
    return ["gcloud", "scheduler", "jobs", action, job, "--project", parts[1], "--location", parts[3], "--format=json"]


def read_scheduler(job: str, adapter) -> dict:
    observed = json.loads(adapter.call(scheduler_command("describe", job), capture=True))
    if not isinstance(observed, dict) or observed.get("name") != job or observed.get("state") not in {"PAUSED", "ENABLED"}:
        raise ValueError("Portal scheduler job is missing or has an unusable state")
    return observed


def scheduler_retries_disabled(observed: dict) -> bool:
    """Both API-default zero limits are required to disable Scheduler retries."""
    retry = observed.get("retryConfig", {})
    if not isinstance(retry, dict):
        return False
    count = retry.get("retryCount", 0)
    duration = retry.get("maxRetryDuration", "0s")
    return isinstance(count, int) and not isinstance(count, bool) and count == 0 and isinstance(duration, str) and re.fullmatch(r"0(?:\.0{1,9})?s", duration) is not None


def observe_scheduler(config: dict, candidate: dict, foundation: dict, adapter) -> dict | None:
    """Read the actual identity and target policy before any image or cloud write."""
    environment = candidate["services"]["portal-ingest"]["environment"]
    if environment.get("PORTAL_SCHEDULER_MODE") != "cloud-scheduler":
        return None
    scheduler = release.foundation_scheduler(foundation)
    expected_account = f"portal-scheduler@{config['project']}.iam.gserviceaccount.com"
    if scheduler["service_account"] != expected_account:
        raise ValueError("Portal scheduler identity differs from the selected project")
    account = json.loads(adapter.call(["gcloud", "iam", "service-accounts", "describe", expected_account,
                                       "--project", config["project"], "--format=json"], capture=True))
    if account.get("uniqueId") != scheduler["subject"] or account.get("email") != expected_account or account.get("disabled", False):
        raise ValueError("Portal scheduler identity has drifted or is disabled")
    for kind in ("drain", "check"):
        job = f"projects/{config['project']}/locations/{config['region']}/jobs/portal-outbox-{kind}"
        if scheduler[kind + "_job"] != job:
            raise ValueError("Portal scheduler job differs from the selected project or region")
        observed = read_scheduler(job, adapter)
        target = observed.get("httpTarget", {})
        expected_token = {"serviceAccountEmail": expected_account, "audience": scheduler["audience"]}
        if target.get("uri") != scheduler["audience"] + "/internal/outbox/" + kind or target.get("httpMethod") != "POST" or target.get("oidcToken") != expected_token or "oauthToken" in target or target.get("body", ""):
            raise ValueError("Portal scheduler target or authentication drift must be reconciled before deployment")
        if observed.get("schedule") != "* * * * *" or observed.get("timeZone") not in {"Etc/UTC", "UTC"} or observed.get("attemptDeadline") != "450s" or not scheduler_retries_disabled(observed):
            raise ValueError("Portal scheduler timing drift must be reconciled before deployment")
        if kind == "check" and observed["state"] != "PAUSED":
            raise ValueError("Portal scheduler check job must remain paused")
    # Fail an operator without execution-log access before lengthy image builds.
    adapter.call(["gcloud", "logging", "read", 'resource.type="cloud_scheduler_job"', "--project", config["project"],
                  "--limit=1", "--format=json"], capture=True)
    return scheduler


def scheduler_timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("Portal scheduler returned an invalid attempt timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError("Portal scheduler returned an attempt timestamp without its timezone")
    return parsed


def wait_scheduler_attempt(scheduler: dict, kind: str, adapter, *, after: datetime, previous_attempt: str | None = None,
                           expected_attempt: str | None = None, require_success: bool = True, maximum_polls: int = 120, wait=time.sleep) -> dict:
    """Correlate one started/finished log pair with the observed attempt, fail closed.

    lastAttemptTime marks dispatch, not completion; its status can still describe
    the prior attempt. A new completed HTTP execution log is required as well.
    The job is paused and retries are disabled, so multiple starts are ambiguous.
    """
    job = scheduler[kind + "_job"]
    uri = scheduler["audience"] + "/internal/outbox/" + kind
    log_name = f"projects/{job.split('/')[1]}/logs/cloudscheduler.googleapis.com%2Fexecutions"
    log_filter = f'resource.type="cloud_scheduler_job" AND logName={json.dumps(log_name)} AND jsonPayload.jobName={json.dumps(job)} AND timestamp>={json.dumps(after.isoformat())}'
    deadline = time.monotonic() + maximum_polls * 5
    for poll in range(maximum_polls):
        if time.monotonic() >= deadline:
            break
        observed = read_scheduler(job, adapter)
        if observed["state"] != "PAUSED":
            raise ValueError("Portal scheduler was enabled during its release check")
        attempt = observed.get("lastAttemptTime")
        if attempt and attempt != previous_attempt and scheduler_timestamp(attempt) >= after:
            if expected_attempt is not None and attempt != expected_attempt:
                raise ValueError("Concurrent Portal scheduler attempts make readiness ambiguous")
            expected_attempt = attempt
            entries = json.loads(adapter.call(["gcloud", "logging", "read", log_filter, "--project", job.split("/")[1],
                                               "--format=json", "--limit=30", "--order=asc"], capture=True))
            if not isinstance(entries, list):
                raise ValueError("Portal scheduler completion logs could not be observed")
            phases = {"Started": {}, "Finished": {}}
            for entry in entries:
                payload = entry.get("jsonPayload", {})
                if payload.get("jobName") != job or payload.get("url") != uri or payload.get("targetType") != "HTTP":
                    continue
                stamp = scheduler_timestamp(entry.get("timestamp"))
                if stamp < after:
                    continue
                for phase in phases:
                    if payload.get("@type") == "type.googleapis.com/google.cloud.scheduler.logging.Attempt" + phase:
                        insert_id = entry.get("insertId")
                        if not isinstance(insert_id, str) or not insert_id:
                            raise ValueError("Portal scheduler completion log lacks its unique ID")
                        phases[phase][insert_id] = entry
            if any(len(entries_by_id) > 1 for entries_by_id in phases.values()):
                raise ValueError("Concurrent Portal scheduler logs make readiness ambiguous")
            if phases["Started"] and phases["Finished"]:
                started = next(iter(phases["Started"].values()))
                finished = next(iter(phases["Finished"].values()))
                start_time, finish_time = scheduler_timestamp(started["timestamp"]), scheduler_timestamp(finished["timestamp"])
                attempt_time = scheduler_timestamp(attempt)
                if finish_time < start_time or finish_time < attempt_time or abs((start_time - attempt_time).total_seconds()) > 30:
                    raise ValueError("Portal scheduler logs do not match the observed attempt")
                status = finished.get("httpRequest", {}).get("status")
                last_status = observed.get("status")
                if require_success and (not isinstance(status, int) or not 200 <= status < 300 or finished["jsonPayload"].get("status", "OK") != "OK" or not isinstance(last_status, dict) or last_status.get("code", 0) != 0):
                    raise ValueError("Portal scheduler authenticated readiness check failed; drain remains paused")
                return {"last_attempt_time": attempt, "completion_log_id": finished["insertId"]}
        if poll and poll % 12 == 0:
            print("Portal: still waiting for the Scheduler attempt and its completion logs", flush=True)
        if poll + 1 < maximum_polls:
            wait(min(5, max(0, deadline - time.monotonic())))
    raise ValueError("Portal scheduler completion was not proven before timeout; drain remains paused. The operator needs Cloud Logging read access; allow for execution-log delivery latency and retry deployment.")


def settle_scheduler(scheduler: dict, kind: str, adapter, *, maximum_polls=120, wait=time.sleep, now=lambda: datetime.now(timezone.utc)) -> None:
    observed = read_scheduler(scheduler[kind + "_job"], adapter)
    if observed.get("attemptDeadline") != "450s" or not scheduler_retries_disabled(observed):
        raise ValueError("Portal scheduler timing drift prevents safe release quiescence")
    if observed.get("lastAttemptTime"):
        attempt = observed["lastAttemptTime"]
        # The request (450s), Cloud Run handler (420s), and runtime (390s) have
        # already stopped beyond this horizon. Old logs may have expired, so do
        # not require permanent historical logging retention to deploy again.
        if (now() - scheduler_timestamp(attempt)).total_seconds() > 480:
            return
        wait_scheduler_attempt(scheduler, kind, adapter, after=scheduler_timestamp(attempt) - timedelta(seconds=1),
                               expected_attempt=attempt, require_success=False, maximum_polls=maximum_polls, wait=wait)


def pause_scheduler(scheduler: dict, adapter, *, maximum_polls=120, wait=time.sleep, now=lambda: datetime.now(timezone.utc)) -> None:
    job = scheduler["drain_job"]
    if read_scheduler(job, adapter)["state"] == "ENABLED":
        print("Portal: pausing scheduled ingestion and waiting for its active attempt to finish", flush=True)
        adapter.call(scheduler_command("pause", job))
    if read_scheduler(job, adapter)["state"] != "PAUSED":
        raise ValueError("Portal scheduler drain could not be paused before release")
    settle_scheduler(scheduler, "drain", adapter, maximum_polls=maximum_polls, wait=wait, now=now)


def require_scheduler_revision(candidate: dict, manifest: Path, config: dict, adapter) -> None:
    """Attest actual ingest traffic, which can drift independently of its template."""
    name = "portal-ingest"
    expected = json.loads(manifest.read_text()).get("services", {}).get(name, {})
    revision = expected.get("deployed_revision")
    digest = release.revision_digest(candidate["services"][name])
    observed = json.loads(adapter.call(release.describe_command(config["project"], config["region"], name), capture=True))
    status = observed.get("status", {})
    allocations = [(entry.get("revisionName"), entry.get("percent")) for entry in status.get("traffic", []) if entry.get("percent", 0) > 0]
    ready = any(condition.get("type") == "Ready" and condition.get("status") == "True" for condition in status.get("conditions", []))
    if not revision or expected.get("revision_digest") != digest or release.observed_digest(name, observed) != digest or allocations != [(revision, 100)] or not ready or status.get("latestReadyRevisionName") != revision or status.get("latestCreatedRevisionName") != revision:
        raise ValueError("Portal scheduler requires 100% traffic on the reviewed ingest revision; reconcile release drift")


def activate_scheduler(scheduler: dict, adapter, *, verify_revision, maximum_polls=120, wait=time.sleep, now=lambda: datetime.now(timezone.utc)) -> dict:
    job = scheduler["check_job"]
    if read_scheduler(job, adapter)["state"] != "PAUSED":
        raise ValueError("Portal scheduler check job must remain paused")
    if read_scheduler(scheduler["drain_job"], adapter)["state"] != "PAUSED":
        raise ValueError("Portal scheduler drain must remain paused until its readiness check passes")
    settle_scheduler(scheduler, "check", adapter, maximum_polls=maximum_polls, wait=wait, now=now)
    verify_revision()
    previous = read_scheduler(job, adapter).get("lastAttemptTime")
    after = now()
    print("Portal: checking the authenticated Scheduler path; waiting for Cloud Logging completion evidence", flush=True)
    adapter.call(scheduler_command("run", job))
    receipt = wait_scheduler_attempt(scheduler, "check", adapter, after=after, previous_attempt=previous,
                                     maximum_polls=maximum_polls, wait=wait)
    verify_revision()
    adapter.call(scheduler_command("resume", scheduler["drain_job"]))
    if read_scheduler(scheduler["drain_job"], adapter)["state"] != "ENABLED":
        raise ValueError("Portal scheduler drain did not become enabled")
    return receipt


def orchestrate(config: dict, state: Path, *, apply: bool, adapter) -> None:
    print("Portal: checking source, configuration and live release state", flush=True)
    source = source_revision(config, adapter)
    target = {key: config[key] for key in ("project", "region", "image_repository", "source_repo_url", "pg_service")}
    target_path = state / "target.json"
    if target_path.exists() and json.loads(target_path.read_text()) != target:
        raise ValueError("Deployment state belongs to another target; use a separate private configuration directory")
    foundation = json.loads(adapter.call(["terraform", f"-chdir={HERE}", "output", "-json"], capture=True))
    number = adapter.call(["gcloud", "projects", "describe", config["project"], "--format=value(projectNumber)"], capture=True).strip()
    expected = f"/projects/{number}/locations/{config['region']}/services/portal-web"
    if not number.isdigit() or release.foundation_audiences(foundation)["portal-web"] != expected:
        raise ValueError("Terraform foundation does not match the selected project and region")
    migration_paths = adapter.call(["git", "ls-tree", "-r", "--name-only", source, "--", "packages/portal/migrations/"], capture=True).splitlines()
    migrations = sorted(Path(path).stem for path in migration_paths if path.endswith(".sql"))
    if not migrations:
        raise ValueError("No portal migrations found in this revision")
    candidate = prepare_plan(config, source, foundation, migrations)
    scheduler = observe_scheduler(config, candidate, foundation, adapter)
    manifest = state / "release-manifest.json"
    current = json.loads(manifest.read_text()) if manifest.exists() else {"generation": 0, "services": {}}
    observe_units(config, current, adapter)
    require_public_schema(config, adapter)
    check_ledger(live_ledger(config, adapter), migrations)
    for script in ("verify-build-context.py", "verify-license-boundary.py"):
        adapter.call([sys.executable, str(HERE / script)])
    adapter.call(["docker", "info"], capture=True)
    adapter.call(["docker", "buildx", "version"], capture=True)
    if not apply:
        print("Portal deployment preflight passed. No images published or cloud resources changed.")
        return
    save_json(target_path, target)
    # Registry authentication uses the operator's existing credential helper;
    # no access token or database credential is passed as a command argument.
    with tempfile.TemporaryDirectory(prefix="build-", dir=state) as directory:
        archive = Path(directory) / "source.tar"
        archive_source(ROOT, source, archive)
        build_images(candidate, config["image_repository"], state, archive, adapter)
    save_json(state / "release-plan.json", candidate)
    if scheduler:
        pause_scheduler(scheduler, adapter)
    release_units(candidate, manifest, project=config["project"], region=config["region"], adapter=adapter,
                  read_ledger=lambda: live_ledger(config, adapter), migration_names=migrations)
    if scheduler:
        receipt = activate_scheduler(scheduler, adapter, verify_revision=lambda: require_scheduler_revision(candidate, manifest, config, adapter))
        save_json(state / "scheduler-readiness.json", {**receipt, "source_commit": source,
                  "ingest_revision_digest": release.revision_digest(candidate["services"]["portal-ingest"])})
    print("Portal deployment completed. Open the configured PORTAL_WEB_ORIGIN to run the pilot checks.")


def private_state(config_path: Path) -> Path:
    config_path = config_path.resolve()
    if config_path.is_relative_to(ROOT):
        relative = str(config_path.relative_to(ROOT))
        tracked = subprocess.run(["git", "-C", str(ROOT), "ls-files", "--", relative], check=True, capture_output=True, text=True).stdout
        ignored = subprocess.run(["git", "-C", str(ROOT), "check-ignore", "-q", relative], capture_output=True).returncode == 0
        if tracked or not ignored:
            raise ValueError("Deployment configuration must be ignored by Git or stored outside the repository")
    state = config_path.parent / "deploy-state"
    if state.is_relative_to(ROOT):
        ignored = subprocess.run(["git", "-C", str(ROOT), "check-ignore", "-q", str((state / "release-manifest.json").relative_to(ROOT))], capture_output=True).returncode == 0
        tracked = subprocess.run(["git", "-C", str(ROOT), "ls-files", "--", str(state.relative_to(ROOT))], check=True, capture_output=True, text=True).stdout
        if not ignored or tracked:
            raise ValueError("Generated deployment state must be ignored by Git; place deploy.json under .local/")
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    state.chmod(0o700)
    return state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(os.environ.get("PORTAL_DEPLOY_CONFIG", str(HERE / ".local/deploy.json"))))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        config = read_config(args.config)
        validate_config(config)
        for command in ("git", "docker", "gcloud", "terraform", "psql", "gh", "curl"):
            if not shutil.which(command):
                raise ValueError(f"Required command is missing: {command}; see the portal deployment README")
        state = private_state(args.config)
        with (state / "deployment.lock").open("w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("Another portal deployment is running for this private configuration") from None
            log = state / ("deploy-" + uuid4().hex + ".log")
            print(f"Portal: private log {log}", flush=True)
            orchestrate(config, state, apply=args.apply, adapter=Commands(log))
    except json.JSONDecodeError:
        print("Error: Invalid JSON in private deployment inputs or provider response; check the private log.", file=sys.stderr)
        raise SystemExit(1) from None
    except subprocess.CalledProcessError:
        print("Error: Portal deployment command failed; inspect the private log for details. Completed steps are retained for retry.", file=sys.stderr)
        raise SystemExit(1) from None
    except ValueError as error:
        # Only our explicit validation messages reach here; provider output is
        # kept in the private log and JSON errors are handled separately above.
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
    except OSError:
        print("Error: Could not read or write deployment inputs/state; inspect local permissions and setup.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
