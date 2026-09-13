#!/usr/bin/env python3
"""Promote selected immutable portal revisions; no cloud write without --apply."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any, NoReturn
from urllib.parse import urlsplit
from uuid import uuid4

UNITS = {"portal-web": "service", "portal-query": "service", "portal-ingest": "service", "portal-parser": "job", "portal-schema": "job", "portal-retention": "job"}
IMAGE = re.compile(r"^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$")
PINNED_SECRET = re.compile(r"^projects/[^/]+/secrets/[a-z0-9-]+/versions/[1-9][0-9]*$")
NO_SECRET_UNITS = {"portal-web", "portal-parser"}
REQUIRED_ENVIRONMENT = {
    "portal-web": {"PORTAL_COMPANY_ID", "PORTAL_MANUAL_SOURCE_JSON", "PORTAL_QUERY_AUDIENCE", "PORTAL_QUERY_URL", "PORTAL_RELEASE_PROFILE", "PORTAL_WEB_IAP_AUDIENCE", "PORTAL_WEB_ORIGIN", "PORTAL_WORKER_AUDIENCE", "PORTAL_WORKER_URL"},
    "portal-query": {"PORTAL_BUSINESS_TIMEZONE", "PORTAL_MANUAL_SOURCE_JSON", "PORTAL_ORIGIN", "PORTAL_RELEASE_PROFILE", "PORTAL_TRUSTED_CALLERS_JSON"},
    "portal-ingest": {"PORTAL_AUTOMATION_USER_ID", "PORTAL_IDENTITY_AUDIENCE", "PORTAL_IDENTITY_URL", "PORTAL_MACHINE_CALLERS_JSON", "PORTAL_MANUAL_SOURCE_JSON", "PORTAL_OBJECT_BUCKET", "PORTAL_PARSER_JOB", "PORTAL_PARSER_LOCATION", "PORTAL_PARSER_OUTPUT_BUCKET", "PORTAL_PARSER_PROJECT", "PORTAL_RELEASE_PROFILE", "PORTAL_TRUSTED_CALLERS_JSON"},
    "portal-parser": set(),
    "portal-schema": set(),
    "portal-retention": {"PORTAL_OBJECT_BUCKET"},
}
# Configuration a unit MAY carry. Unlike REQUIRED_ENVIRONMENT this is an allowance
# only: absence is never an error. `PORTAL_SOURCES_JSON` is the query service's
# live-source registry, and only the query service reads it, so admitting it
# anywhere else would stage a revision carrying configuration nothing consumes.
SCHEDULER_ENVIRONMENT = {"PORTAL_SCHEDULER_MODE", "PORTAL_SCHEDULER_AUDIENCE", "PORTAL_SCHEDULER_SUBJECT", "PORTAL_DATABASE_METRIC_TYPE"}
OPTIONAL_ENVIRONMENT = {"portal-query": {"PORTAL_SOURCES_JSON"}, "portal-ingest": SCHEDULER_ENVIRONMENT}
# The manual release registers live CARBON sources only. Kanban belongs to the
# deferred command surface and `engineering`/`crm` are the generic source adapters
# this release excludes, so admitting the registry key without this would reverse
# that decision by the back door. Which Carbon source a deployment registers — its
# id, origin and audience — remains entirely the operator's.
SOURCE_REGISTRY_KINDS = {"carbon"}
SOURCE_REGISTRY_FIELDS = {"id", "kind", "origin", "audience"}
REQUIRED_SECRETS = {
    "portal-web": set(),
    "portal-query": {"PORTAL_READ_DATABASE_URL", "PORTAL_REDIS_URL"},
    "portal-ingest": {"INNGEST_SIGNING_KEY", "PORTAL_INGEST_DATABASE_URL", "PORTAL_READ_DATABASE_URL", "PORTAL_REVIEW_DATABASE_URL"},
    "portal-parser": set(),
    "portal-schema": {"PORTAL_MIGRATION_DATABASE_URL"},
    "portal-retention": {"PORTAL_MAINTENANCE_DATABASE_URL"},
}
# Audience environment variables are derived from the Terraform foundation
# (`terraform output -json`, key `service_audiences`), keyed by the service whose
# audience they carry. A plan value is accepted only when it matches, or with the
# explicit --override-audiences flag.
AUDIENCE_ENVIRONMENT = {
    "portal-web": {"PORTAL_WEB_IAP_AUDIENCE": "portal-web", "PORTAL_QUERY_AUDIENCE": "portal-query", "PORTAL_WORKER_AUDIENCE": "portal-ingest"},
    "portal-ingest": {"PORTAL_IDENTITY_AUDIENCE": "portal-query"},
}
# Service-level (not revision) annotations Terraform owns on portal-web. A v1
# `replace` writes the whole Service, so the controller copies these from the
# observed service instead of letting a promotion silently reset them.
FOUNDATION_SERVICE_ANNOTATIONS = ("run.googleapis.com/iap-enabled", "run.googleapis.com/ingress", "run.googleapis.com/custom-audiences", "run.googleapis.com/binary-authorization")
IAP_ANNOTATION = "run.googleapis.com/iap-enabled"
IAP_SERVICES = {"portal-web"}
# Units holding a database credential get the network tag the foundation's
# egress firewall allows toward Carbon's private PostgreSQL listener.
SOURCE_DATABASE_CLIENT_TAG = "portal-source-database-client"
DATABASE_UNITS = frozenset(name for name, secrets in REQUIRED_SECRETS.items() if any(key.endswith("_DATABASE_URL") for key in secrets))
# Portal migrations are `<14-digit timestamp>_<slug>` files applied in name order, so
# the ledger head (`max(name)` in `portal_migrations.ledger`) and a unit's compatible
# window compare as plain strings. Every database unit declares the window its build
# was verified against; the controller refuses to promote it onto a ledger outside it.
MIGRATION_NAME = re.compile(r"^[0-9]{14}_[a-z0-9-]+$")
LEDGER_SCHEMA_VERSION = 1


def canonical_digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def foundation_audiences(outputs: dict[str, Any]) -> dict[str, str]:
    """Read `service_audiences` from a `terraform output -json` document."""
    audiences = outputs.get("service_audiences", {}).get("value") if isinstance(outputs.get("service_audiences"), dict) else None
    if not isinstance(audiences, dict) or not audiences:
        raise ValueError("Foundation outputs must contain the service_audiences map from `terraform output -json`")
    expected = {receiver for mapping in AUDIENCE_ENVIRONMENT.values() for receiver in mapping.values()}
    missing = sorted(expected - audiences.keys())
    if missing or not all(isinstance(value, str) and value for value in audiences.values()):
        raise ValueError(f"Foundation outputs lack an audience for: {', '.join(missing) or 'a receiver'}")
    return {name: value for name, value in audiences.items()}


def apply_foundation_audiences(plan: dict[str, Any], outputs: dict[str, Any], *, override: bool = False) -> dict[str, Any]:
    """Fill audience environment from the foundation; refuse silent drift from it."""
    audiences = foundation_audiences(outputs)
    services = plan.get("services")
    if not isinstance(services, dict):
        raise ValueError("Release plan services must be an object")
    for name, mapping in AUDIENCE_ENVIRONMENT.items():
        spec = services.get(name)
        if not isinstance(spec, dict):
            continue
        environment = spec.setdefault("environment", {})
        if not isinstance(environment, dict):
            raise ValueError(f"{name} environment and secrets must be objects")
        for variable, receiver in mapping.items():
            expected = audiences[receiver]
            current = environment.get(variable)
            if current is None:
                environment[variable] = expected
            elif current != expected and not override:
                raise ValueError(f"{name} {variable} differs from the foundation output for {receiver}; pass --override-audiences to keep the plan value")
    ingest = services.get("portal-ingest", {}).get("environment", {})
    if ingest.get("PORTAL_SCHEDULER_MODE") == "cloud-scheduler":
        scheduler = foundation_scheduler(outputs)
        values = {"PORTAL_SCHEDULER_SUBJECT": scheduler["subject"], "PORTAL_SCHEDULER_AUDIENCE": scheduler["audience"],
                  "PORTAL_DATABASE_METRIC_TYPE": outputs.get("database_connection_utilization_metric_type", {}).get("value")}
        if not isinstance(values["PORTAL_DATABASE_METRIC_TYPE"], str) or not values["PORTAL_DATABASE_METRIC_TYPE"].startswith("custom.googleapis.com/"):
            raise ValueError("Foundation outputs must contain database_connection_utilization_metric_type")
        for variable, expected in values.items():
            if variable in ingest and ingest[variable] != expected:
                raise ValueError(f"Portal scheduler {variable} differs from the foundation output")
            ingest[variable] = expected
    return plan


def foundation_scheduler(outputs: dict[str, Any]) -> dict[str, str]:
    scheduler = outputs.get("outbox_scheduler", {}).get("value")
    fields = {"service_account", "subject", "audience", "drain_job", "check_job"}
    if not isinstance(scheduler, dict) or set(scheduler) != fields or any(not isinstance(value, str) or not value for value in scheduler.values()):
        raise ValueError("Foundation outputs must contain the outbox_scheduler map")
    if not re.fullmatch(r"[0-9]{6,30}", scheduler["subject"]) or scheduler["audience"] != foundation_audiences(outputs)["portal-ingest"]:
        raise ValueError("Foundation outbox_scheduler requires the numeric service-account identity and ingest audience")
    return dict(scheduler)


def check_source_registry(name: str, value: Any) -> None:
    """Refuse a live-source registry the query service would refuse to boot on.

    `readSourceRegistryConfiguration` throws on a malformed registry rather than
    starting with no sources, so without this the only symptom of a typo is a
    revision that never becomes Ready. Same shape as
    `sourceRegistryConfigurationSchema`, narrowed to the kinds this release ships.
    """
    def refuse() -> NoReturn:
        raise ValueError(f"{name} requires a strict live-source registry")
    try:
        registry = json.loads(value)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"{name} requires a strict live-source registry") from error
    if not isinstance(registry, dict) or set(registry) != {"version", "sources"} or registry["version"] != 1:
        refuse()
    sources = registry["sources"]
    if not isinstance(sources, list) or len(sources) > 100:
        refuse()
    for source in sources:
        if not isinstance(source, dict) or set(source) != SOURCE_REGISTRY_FIELDS:
            refuse()
        if source["kind"] not in SOURCE_REGISTRY_KINDS:
            raise ValueError(f"{name} registers a source kind this release does not ship: {source['kind']}")
        for field in ("id", "audience"):
            if not isinstance(source[field], str) or not 1 <= len(source[field]) <= (256 if field == "id" else 2048):
                refuse()
        origin = source["origin"]
        if not isinstance(origin, str):
            refuse()
        parts = urlsplit(origin)
        # A bare https origin: the transport refuses a plaintext or credentialed
        # URL it acquires, and configuration is not a way around that.
        if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment:
            raise ValueError(f"{name} requires each source origin to be a bare https URL without credentials")
    if len({source["id"] for source in sources}) != len(sources):
        raise ValueError(f"{name} registers two sources under one ID")


def validate_plan(plan: dict[str, Any]) -> None:
    if plan.get("schema_version") != 1 or not isinstance(plan.get("generation"), int):
        raise ValueError("Release plan must use schema_version 1 and an integer generation")
    if not isinstance(plan.get("source_commit"), str) or not re.fullmatch(r"[0-9a-f]{40}", plan["source_commit"]):
        raise ValueError("Release plan requires its exact source_commit")
    services = plan.get("services")
    if not isinstance(services, dict):
        raise ValueError("Release plan services must be an object")
    selected = plan.get("deploy", {})
    for name in selected:
        if name not in UNITS or name not in services:
            raise ValueError(f"Unknown selected portal unit: {name}")
    for name, spec in services.items():
        if name not in UNITS:
            raise ValueError(f"Unknown portal unit: {name}")
        if spec.get("kind") != UNITS[name]:
            raise ValueError(f"{name} has the wrong Cloud Run kind")
        if not spec.get("implementation_ready"):
            raise ValueError(f"{name} is not implementation-ready; the controller will not create a placeholder runtime")
        if not IMAGE.fullmatch(spec.get("image", "")):
            raise ValueError(f"{name} requires an immutable image digest")
        if not isinstance(spec.get("service_account"), str) or not spec["service_account"].endswith(".iam.gserviceaccount.com"):
            raise ValueError(f"{name} requires its attached workload identity")
        if not isinstance(spec.get("environment"), dict) or not isinstance(spec.get("secrets"), dict):
            raise ValueError(f"{name} environment and secrets must be objects")
        for version in spec["secrets"].values():
            if not PINNED_SECRET.fullmatch(version):
                raise ValueError(f"{name} requires a pinned secret version, never latest")
        if "redis_ca_secret" in spec:
            if name != "portal-query":
                raise ValueError(f"{name} cannot receive a Redis CA")
            if not isinstance(spec["redis_ca_secret"], str) or not PINNED_SECRET.fullmatch(spec["redis_ca_secret"]):
                raise ValueError(f"{name} requires a pinned Redis CA secret version, never latest")
        if "database_ca_secret" in spec:
            if name not in DATABASE_UNITS:
                raise ValueError(f"{name} cannot receive a database CA")
            if not isinstance(spec["database_ca_secret"], str) or not PINNED_SECRET.fullmatch(spec["database_ca_secret"]):
                raise ValueError(f"{name} requires a pinned database CA secret version, never latest")
        if name in NO_SECRET_UNITS and spec["secrets"]:
            raise ValueError(f"{name} must not receive runtime secrets")
        extra_environment = spec["environment"].keys() - REQUIRED_ENVIRONMENT[name] - OPTIONAL_ENVIRONMENT.get(name, set())
        required_secrets = set(REQUIRED_SECRETS[name])
        if name == "portal-ingest":
            environment = spec["environment"]
            mode = environment.get("PORTAL_SCHEDULER_MODE", "inngest")
            if mode not in {"inngest", "cloud-scheduler"}:
                raise ValueError("Unknown Portal scheduler mode")
            if mode == "cloud-scheduler":
                if not SCHEDULER_ENVIRONMENT <= environment.keys():
                    raise ValueError("Portal cloud scheduler requires its audience, subject and database metric")
                audience = urlsplit(environment["PORTAL_SCHEDULER_AUDIENCE"])
                if audience.scheme != "https" or not audience.netloc or audience.path or audience.query or audience.fragment or audience.username or audience.password:
                    raise ValueError("Portal scheduler audience must be an HTTPS service origin")
                if not re.fullmatch(r"[0-9]{6,30}", environment["PORTAL_SCHEDULER_SUBJECT"]):
                    raise ValueError("Portal scheduler subject must be a numeric service-account identity")
                if not environment["PORTAL_DATABASE_METRIC_TYPE"].startswith("custom.googleapis.com/"):
                    raise ValueError("Portal scheduler requires its custom database metric type")
                required_secrets.remove("INNGEST_SIGNING_KEY")
            elif (SCHEDULER_ENVIRONMENT - {"PORTAL_SCHEDULER_MODE"}) & environment.keys():
                raise ValueError("Portal scheduler identity and metric inputs require cloud-scheduler mode")
        extra_secrets = spec["secrets"].keys() - required_secrets
        if extra_environment or extra_secrets:
            deferred = sorted(extra_environment | extra_secrets)
            raise ValueError(f"{name} contains deferred runtime configuration: {', '.join(deferred)}")
        missing_environment = REQUIRED_ENVIRONMENT[name] - spec["environment"].keys()
        missing_secrets = required_secrets - spec["secrets"].keys()
        if missing_environment or missing_secrets:
            missing = sorted(missing_environment | missing_secrets)
            raise ValueError(f"{name} is missing mandatory runtime configuration: {', '.join(missing)}")
        if name in {"portal-web", "portal-query", "portal-ingest"} and spec["environment"].get("PORTAL_RELEASE_PROFILE") != "manual-v1":
            raise ValueError(f"{name} must use the manual-v1 release profile")
        if "PORTAL_MANUAL_SOURCE_JSON" in spec["environment"]:
            try:
                source = json.loads(spec["environment"]["PORTAL_MANUAL_SOURCE_JSON"])
            except (TypeError, json.JSONDecodeError) as error:
                raise ValueError(f"{name} requires strict manual source configuration") from error
            if not isinstance(source, dict) or set(source) != {"sourceId", "displayName"} or not isinstance(source["sourceId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", source["sourceId"]) or not isinstance(source["displayName"], str) or not 1 <= len(source["displayName"].strip()) <= 200:
                raise ValueError(f"{name} requires strict manual source configuration")
        if "PORTAL_SOURCES_JSON" in spec["environment"]:
            check_source_registry(name, spec["environment"]["PORTAL_SOURCES_JSON"])
        if not isinstance(spec.get("network"), str) or not spec["network"] or not isinstance(spec.get("subnetwork"), str) or not spec["subnetwork"] or spec.get("egress") != "all-traffic":
            raise ValueError(f"{name} requires Direct VPC egress through the private network")
        if not isinstance(spec.get("max_instances"), int) or spec["max_instances"] < 1:
            raise ValueError(f"{name} requires a bounded max_instances")
        if not isinstance(spec.get("concurrency"), int) or spec["concurrency"] < 1:
            raise ValueError(f"{name} requires bounded concurrency")
        migrations = spec.get("migrations")
        if name in DATABASE_UNITS:
            if not isinstance(migrations, dict) or set(migrations) != {"minimum", "maximum"} or not all(isinstance(migrations[key], str) and MIGRATION_NAME.fullmatch(migrations[key]) for key in ("minimum", "maximum")):
                raise ValueError(f"{name} requires migrations.minimum and migrations.maximum portal migration names")
            if migrations["minimum"] > migrations["maximum"]:
                raise ValueError(f"{name} migrations.minimum is newer than migrations.maximum")
        elif migrations is not None:
            raise ValueError(f"{name} holds no database credential and cannot declare migration compatibility")
    receipts = plan.get("build_receipt", {})
    if not isinstance(receipts, dict):
        raise ValueError("build_receipt must be an object")
    for name in selected:
        receipt = receipts.get(name)
        image = services[name]["image"]
        if not isinstance(receipt, dict) or receipt.get("image") != image or receipt.get("image_digest") != image.rsplit("@", 1)[1] or receipt.get("source_commit") != plan["source_commit"]:
            raise ValueError(f"{name} needs the verified build receipt for its selected immutable image")


def ledger_head(ledger: dict[str, Any]) -> str | None:
    """Head of an observed `portal_migrations.ledger`; None when no migration has been applied."""
    if not isinstance(ledger, dict) or ledger.get("schema_version") != LEDGER_SCHEMA_VERSION or not isinstance(ledger.get("names"), list):
        raise ValueError("Schema ledger observation must use schema_version 1 and a names list")
    # `applyPortalMigrations` records the file name, `.sql` included; windows use the bare name.
    names = [name[:-4] if isinstance(name, str) and name.endswith(".sql") else name for name in ledger["names"]]
    if not all(isinstance(name, str) and MIGRATION_NAME.fullmatch(name) for name in names):
        raise ValueError("Schema ledger observation contains a name that is not a portal migration")
    return max(names) if names else None


def check_migration_compatibility(plan: dict[str, Any], ledger: dict[str, Any] | None) -> dict[str, str | None]:
    """Refuse a database unit whose compatible window does not contain the deployed ledger head."""
    selected = [name for name in sorted(plan.get("deploy", {})) if name in DATABASE_UNITS]
    if not selected:
        return {}
    if ledger is None:
        raise ValueError(f"Promoting {', '.join(selected)} requires --schema-ledger, the observed portal_migrations.ledger")
    head = ledger_head(ledger)
    for name in selected:
        window = plan["services"][name]["migrations"]
        if head is None:
            if name != "portal-schema":
                raise ValueError(f"{name} cannot be promoted before the schema job applies the first portal migration")
            continue
        if head < window["minimum"]:
            raise ValueError(f"{name} requires migration {window['minimum']} but the ledger head is {head}; run the schema job first")
        if head > window["maximum"]:
            raise ValueError(f"{name} supports migrations up to {window['maximum']} but the ledger head is {head}; select a build verified against it")
    return {name: head for name in selected}


def revision_digest(spec: dict[str, Any]) -> str:
    values = {key: spec[key] for key in ("image", "service_account", "environment", "secrets", "resources", "max_instances", "concurrency", "network", "subnetwork", "egress")}
    if "database_ca_secret" in spec:
        values["database_ca_secret"] = spec["database_ca_secret"]
    if "redis_ca_secret" in spec:
        values["redis_ca_secret"] = spec["redis_ca_secret"]
    return canonical_digest(values)


def select_mutations(plan: dict[str, Any], current: dict[str, Any], observed: dict[str, str], ledger: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    validate_plan(plan)
    check_migration_compatibility(plan, ledger)
    if current.get("generation") != plan.get("expected_generation"):
        raise ValueError("Release manifest generation changed; re-plan before promotion")
    mutations = []
    for name in sorted(plan.get("deploy", {})):
        previous = current.get("services", {}).get(name, {})
        expected = previous.get("revision_digest")
        if not expected and name in observed and (name != "portal-web" or observed[name]):
            raise ValueError(f"Existing unrecorded runtime for {name}; reconcile the private manifest before promotion")
        if expected and observed.get(name) != expected:
            raise ValueError(f"Manual configuration drift for {name}; review it before promotion")
        mutations.append({"name": name, "kind": UNITS[name], "strategy": "stage-then-promote" if UNITS[name] == "service" else "replace-without-execute", "revision_digest": revision_digest(plan["services"][name])})
    return mutations


def run(args: list[str], *, capture: bool = False) -> str:
    result = subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout if capture else ""


DIGEST_LABEL = "portal-revision-digest"


def digest_label(digest: str) -> str:
    """Store all 256 bits in a Cloud Run label (hex plus prefix exceeds 63 chars)."""
    if re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        return "sha256-" + base64.b32encode(bytes.fromhex(digest[7:])).decode().lower().rstrip("=")
    return digest


def observed_digest(name: str, document: dict[str, Any]) -> str:
    template = document.get("spec", {}).get("template", {})
    labels = template.get("metadata", {}).get("labels", {})
    value = labels.get(DIGEST_LABEL, labels.get("portal.carbon/revision-digest", ""))
    if re.fullmatch(r"sha256-[a-z2-7]{52}", value):
        return "sha256:" + base64.b32decode(value[7:].upper() + "====").hex()
    return value


def describe_command(project: str, region: str, name: str) -> list[str]:
    return ["gcloud", "run", "jobs" if UNITS[name] == "job" else "services", "describe", name, "--project", project, "--region", region, "--format=json"]


def observed_revision_digests(project: str, region: str, names: list[str]) -> dict[str, str]:
    result = {}
    for name in names:
        try:
            document = json.loads(run(describe_command(project, region, name), capture=True))
        except subprocess.CalledProcessError:
            continue
        result[name] = observed_digest(name, document)
    return result


class Gcloud:
    """Small process adapter; tests use the same command protocol in memory."""
    def call(self, args: list[str], *, capture: bool = False) -> str:
        return run(args, capture=capture)


def secret_reference(value: str) -> tuple[str, str]:
    parts = value.split("/")
    # Cloud Run's v1 SecretKeySelector takes the secret ID, while the private
    # release input carries a fully qualified, version-pinned Secret Manager
    # reference so cross-project or `latest` references cannot slip through.
    return parts[-3], parts[-1]


def foundation_service_annotations(name: str, observed: dict[str, Any] | None) -> dict[str, str]:
    """Return the Terraform-owned service annotations a replacement must keep."""
    annotations = (observed or {}).get("metadata", {}).get("annotations", {}) if observed else {}
    kept = {key: annotations[key] for key in FOUNDATION_SERVICE_ANNOTATIONS if isinstance(annotations.get(key), str)}
    if name in IAP_SERVICES and kept.get(IAP_ANNOTATION) != "true":
        raise ValueError(f"{name} foundation shell with IAP enabled is not applied; run terraform apply before promoting it")
    return kept


def revision_document(name: str, spec: dict[str, Any], digest: str, observed: dict[str, Any] | None = None) -> dict[str, Any]:
    environment = [{"name": key, "value": value} for key, value in sorted(spec["environment"].items())]
    environment += [{"name": key, "valueFrom": {"secretKeyRef": {"name": secret_reference(value)[0], "key": secret_reference(value)[1]}}} for key, value in sorted(spec["secrets"].items())]
    interface: dict[str, Any] = {"network": spec["network"], "subnetwork": spec["subnetwork"]}
    if name in DATABASE_UNITS:
        interface["tags"] = [SOURCE_DATABASE_CLIENT_TAG]
    template = {
        "metadata": {
            "labels": {DIGEST_LABEL: digest_label(digest)},
            "annotations": {
                "run.googleapis.com/network-interfaces": json.dumps([interface], separators=(",", ":")),
                "run.googleapis.com/vpc-access-egress": spec["egress"],
            },
        },
        "spec": {
            "serviceAccountName": spec["service_account"],
            "containers": [{"image": spec["image"], "env": environment, "resources": {"limits": spec["resources"]}}],
        },
    }
    if "database_ca_secret" in spec:
        secret, version = secret_reference(spec["database_ca_secret"])
        template["spec"]["volumes"] = [{"name": "database-ca", "secret": {"secretName": secret, "items": [{"key": version, "path": "ca.crt"}]}}]
        template["spec"]["containers"][0]["volumeMounts"] = [{"name": "database-ca", "mountPath": "/var/run/secrets/portal-source-database"}]
    if "redis_ca_secret" in spec:
        secret, version = secret_reference(spec["redis_ca_secret"])
        template["spec"].setdefault("volumes", []).append({"name": "redis-ca", "secret": {"secretName": secret, "items": [{"key": version, "path": "ca.pem"}]}})
        container = template["spec"]["containers"][0]
        container.setdefault("volumeMounts", []).append({"name": "redis-ca", "mountPath": "/var/run/secrets/portal-redis-ca"})
        container["env"].append({"name": "PORTAL_REDIS_TLS_CA_FILE", "value": "/var/run/secrets/portal-redis-ca/ca.pem"})
    if spec["kind"] == "job":
        template["spec"].update(maxRetries=0, timeoutSeconds="3600")
        return {"apiVersion": "run.googleapis.com/v1", "kind": "Job", "metadata": {"name": name}, "spec": {"template": {"metadata": template["metadata"], "spec": {"taskCount": 1, "parallelism": 1, "template": {"spec": template["spec"]}}}}}
    template["metadata"]["name"] = f"{name}-{uuid4().hex[:16]}"
    template["spec"]["containerConcurrency"] = spec["concurrency"]
    if name == "portal-ingest" and spec["environment"].get("PORTAL_SCHEDULER_MODE") == "cloud-scheduler":
        template["spec"]["timeoutSeconds"] = 420
    # Cloud Run runs this against the staged container before declaring its
    # revision ready, without routing to the old revision or bypassing IAP.
    template["spec"]["containers"][0]["startupProbe"] = {
        "httpGet": {"path": "/health", "port": 8080},
        "timeoutSeconds": 5, "periodSeconds": 5, "failureThreshold": 48,
    }
    template["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = str(spec["max_instances"])
    metadata: dict[str, Any] = {"name": name}
    kept = foundation_service_annotations(name, observed)
    if kept:
        metadata["annotations"] = kept
    service_spec = {"template": template}
    prior = (observed or {}).get("status", {}).get("traffic", [])
    if prior:
        # `services replace` has no --no-traffic flag. Explicitly pin all
        # existing allocations while the new revision passes its startup probe.
        service_spec["traffic"] = [{key: entry[key] for key in ("revisionName", "percent", "tag") if key in entry} for entry in prior]
    return {"apiVersion": "serving.knative.dev/v1", "kind": "Service", "metadata": metadata, "spec": service_spec}


def save_manifest(path: Path, plan: dict[str, Any], current: dict[str, Any], mutations: list[dict[str, Any]]) -> None:
    services = dict(current.get("services", {}))
    for mutation in mutations:
        services[mutation["name"]] = {
            "revision_digest": mutation["revision_digest"],
            "image_digest": plan["services"][mutation["name"]]["image"].rsplit("@", 1)[1],
            "deployed_revision": mutation.get("deployed_revision"),
            "migrations": plan["services"][mutation["name"]].get("migrations"),
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as stream:
        json.dump({"generation": plan["generation"], "services": services}, stream, sort_keys=True)
        stream.write("\n")
        temporary = Path(stream.name)
    temporary.chmod(0o600)
    temporary.replace(path)


def promote(plan: dict[str, Any], current: dict[str, Any], *, project: str, region: str, manifest: Path, adapter: Gcloud, ledger: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    selected = sorted(plan.get("deploy", {}))
    observed_documents: dict[str, dict[str, Any]] = {}
    observed = {}
    for name in selected:
        try:
            document = json.loads(adapter.call(describe_command(project, region, name), capture=True))
        except subprocess.CalledProcessError:
            continue
        observed_documents[name] = document
        observed[name] = observed_digest(name, document)
    mutations = select_mutations(plan, current, observed, ledger)
    # Render every document before the first write so a missing IAP shell
    # refuses the whole promotion instead of a partial one.
    documents = {mutation["name"]: revision_document(mutation["name"], plan["services"][mutation["name"]], mutation["revision_digest"], observed_documents.get(mutation["name"])) for mutation in mutations}
    promoted: list[dict[str, Any]] = []
    for mutation in mutations:
        name = mutation["name"]
        document = documents[name]
        restore_previous = True
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as stream:
            json.dump(document, stream)
            rendered = Path(stream.name)
        try:
            command = ["gcloud", "run", "jobs" if mutation["kind"] == "job" else "services", "replace", str(rendered), "--project", project, "--region", region]
            adapter.call(command)
            if mutation["kind"] == "service":
                ready = json.loads(adapter.call(describe_command(project, region, name), capture=True))
                status = ready.get("status", {})
                revision = document["spec"]["template"]["metadata"]["name"]
                restore_previous = status.get("latestCreatedRevisionName") == revision
                if status.get("latestCreatedRevisionName") != revision or status.get("latestReadyRevisionName") != revision or not any(condition.get("type") == "Ready" and condition.get("status") == "True" for condition in status.get("conditions", [])):
                    raise ValueError(f"{name} staged revision did not become Ready with its HTTP startup probe")
                adapter.call(["gcloud", "run", "services", "update-traffic", name, f"--to-revisions={revision}=100", "--project", project, "--region", region])
                mutation["deployed_revision"] = revision
            else:
                replaced = json.loads(adapter.call(["gcloud", "run", "jobs", "describe", name, "--project", project, "--region", region, "--format=json"], capture=True))
                mutation["deployed_revision"] = str(replaced.get("metadata", {}).get("generation", ""))
                if not mutation["deployed_revision"]:
                    raise ValueError(f"{name} replacement did not expose its observed generation")
            promoted.append(mutation)
            # Preserve proven progress if a later independent unit fails.
            save_manifest(manifest, plan, current, promoted)
        except Exception:
            previous = observed_documents.get(name)
            if mutation["kind"] == "service" and previous and restore_previous:
                # Restoring traffic alone leaves the failed template as the
                # latest desired configuration and makes retry trip drift checks.
                # Restore the complete observed template before pinning traffic.
                prior = previous.get("status", {}).get("traffic", [])
                traffic = [{key: entry[key] for key in ("revisionName", "percent", "tag") if key in entry} for entry in prior]
                restore = {
                    "apiVersion": "serving.knative.dev/v1", "kind": "Service",
                    "metadata": {key: value for key, value in previous.get("metadata", {}).items() if key in {"name", "annotations", "labels"}},
                    "spec": dict(previous["spec"]),
                }
                if traffic:
                    restore["spec"]["traffic"] = traffic
                rendered.write_text(json.dumps(restore))
                try:
                    adapter.call(["gcloud", "run", "services", "replace", str(rendered), "--project", project, "--region", region])
                    allocation = ",".join(f"{entry['revisionName']}={entry['percent']}" for entry in traffic if entry.get("revisionName") and entry.get("percent", 0) > 0)
                    if allocation:
                        adapter.call(["gcloud", "run", "services", "update-traffic", name, f"--to-revisions={allocation}", "--project", project, "--region", region])
                except Exception as restore_error:
                    raise ValueError(f"{name} failed and its prior service configuration could not be restored; reconcile it before retrying") from restore_error
            raise
        finally:
            rendered.unlink(missing_ok=True)
    save_manifest(manifest, plan, current, promoted)
    return promoted


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--current", required=True, type=Path, help="private last-successful manifest")
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--foundation-outputs", type=Path, help="JSON from `terraform -chdir=contrib/deploying/portal output -json`; supplies every service audience")
    parser.add_argument("--override-audiences", action="store_true", help="keep audience values written in the plan even where they differ from the foundation outputs")
    parser.add_argument("--schema-ledger", type=Path, help="JSON observation of portal_migrations.ledger ({schema_version: 1, names: [...]}); required when a database unit is selected")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.foundation_outputs is None and not args.override_audiences:
        parser.error("--foundation-outputs is required unless --override-audiences explicitly keeps the plan's audience values")
    plan, current = json.loads(args.plan.read_text()), json.loads(args.current.read_text())
    if args.foundation_outputs is not None:
        plan = apply_foundation_audiences(plan, json.loads(args.foundation_outputs.read_text()), override=args.override_audiences)
    ledger = json.loads(args.schema_ledger.read_text()) if args.schema_ledger is not None else None
    selected = sorted(plan.get("deploy", {}))
    mutations = select_mutations(plan, current, observed_revision_digests(args.project, args.region, selected) if args.apply else {name: current["services"][name]["revision_digest"] for name in selected if current.get("services", {}).get(name, {}).get("revision_digest")}, ledger)
    if not args.apply:
        print(json.dumps({"mutations": mutations}, indent=2))
        return
    promoted = promote(plan, current, project=args.project, region=args.region, manifest=args.current, adapter=Gcloud(), ledger=ledger)
    print(json.dumps({"promoted": promoted}, indent=2))


if __name__ == "__main__":
    main()
