#!/usr/bin/env python3
"""Promote selected immutable knowledge revisions; no cloud write without --apply."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any

UNITS = {"knowledge-web": "service", "knowledge-query": "service", "knowledge-ingest": "service", "knowledge-parser": "job", "knowledge-schema": "job", "knowledge-retention": "job"}
IMAGE = re.compile(r"^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$")
PINNED_SECRET = re.compile(r"^projects/[^/]+/secrets/[a-z0-9-]+/versions/[1-9][0-9]*$")
NO_SECRET_UNITS = {"knowledge-web", "knowledge-parser"}
REQUIRED_ENVIRONMENT = {
    "knowledge-web": {"KNOWLEDGE_COMPANY_ID", "KNOWLEDGE_MANUAL_SOURCE_JSON", "KNOWLEDGE_QUERY_AUDIENCE", "KNOWLEDGE_QUERY_URL", "KNOWLEDGE_RELEASE_PROFILE", "KNOWLEDGE_WEB_IAP_AUDIENCE", "KNOWLEDGE_WEB_ORIGIN", "KNOWLEDGE_WORKER_AUDIENCE", "KNOWLEDGE_WORKER_URL"},
    "knowledge-query": {"KNOWLEDGE_BUSINESS_TIMEZONE", "KNOWLEDGE_MANUAL_SOURCE_JSON", "KNOWLEDGE_PORTAL_ORIGIN", "KNOWLEDGE_RELEASE_PROFILE", "KNOWLEDGE_TRUSTED_CALLERS_JSON"},
    "knowledge-ingest": {"KNOWLEDGE_AUTOMATION_USER_ID", "KNOWLEDGE_IDENTITY_AUDIENCE", "KNOWLEDGE_IDENTITY_URL", "KNOWLEDGE_MACHINE_CALLERS_JSON", "KNOWLEDGE_MANUAL_SOURCE_JSON", "KNOWLEDGE_OBJECT_BUCKET", "KNOWLEDGE_PARSER_JOB", "KNOWLEDGE_PARSER_LOCATION", "KNOWLEDGE_PARSER_OUTPUT_BUCKET", "KNOWLEDGE_PARSER_PROJECT", "KNOWLEDGE_RELEASE_PROFILE", "KNOWLEDGE_TRUSTED_CALLERS_JSON"},
    "knowledge-parser": set(),
    "knowledge-schema": set(),
    "knowledge-retention": {"KNOWLEDGE_OBJECT_BUCKET"},
}
REQUIRED_SECRETS = {
    "knowledge-web": set(),
    "knowledge-query": {"KNOWLEDGE_READ_DATABASE_URL", "KNOWLEDGE_REDIS_URL"},
    "knowledge-ingest": {"INNGEST_SIGNING_KEY", "KNOWLEDGE_INGEST_DATABASE_URL", "KNOWLEDGE_READ_DATABASE_URL", "KNOWLEDGE_REVIEW_DATABASE_URL"},
    "knowledge-parser": set(),
    "knowledge-schema": {"KNOWLEDGE_MIGRATION_DATABASE_URL"},
    "knowledge-retention": {"KNOWLEDGE_MAINTENANCE_DATABASE_URL"},
}


def canonical_digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


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
            raise ValueError(f"Unknown selected knowledge unit: {name}")
    for name, spec in services.items():
        if name not in UNITS:
            raise ValueError(f"Unknown knowledge unit: {name}")
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
        if name in NO_SECRET_UNITS and spec["secrets"]:
            raise ValueError(f"{name} must not receive runtime secrets")
        extra_environment = spec["environment"].keys() - REQUIRED_ENVIRONMENT[name]
        extra_secrets = spec["secrets"].keys() - REQUIRED_SECRETS[name]
        if extra_environment or extra_secrets:
            deferred = sorted(extra_environment | extra_secrets)
            raise ValueError(f"{name} contains deferred runtime configuration: {', '.join(deferred)}")
        missing_environment = REQUIRED_ENVIRONMENT[name] - spec["environment"].keys()
        missing_secrets = REQUIRED_SECRETS[name] - spec["secrets"].keys()
        if missing_environment or missing_secrets:
            missing = sorted(missing_environment | missing_secrets)
            raise ValueError(f"{name} is missing mandatory runtime configuration: {', '.join(missing)}")
        if name in {"knowledge-web", "knowledge-query", "knowledge-ingest"} and spec["environment"].get("KNOWLEDGE_RELEASE_PROFILE") != "manual-v1":
            raise ValueError(f"{name} must use the manual-v1 release profile")
        if "KNOWLEDGE_MANUAL_SOURCE_JSON" in spec["environment"]:
            try:
                source = json.loads(spec["environment"]["KNOWLEDGE_MANUAL_SOURCE_JSON"])
            except (TypeError, json.JSONDecodeError) as error:
                raise ValueError(f"{name} requires strict manual source configuration") from error
            if not isinstance(source, dict) or set(source) != {"sourceId", "displayName"} or not isinstance(source["sourceId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", source["sourceId"]) or not isinstance(source["displayName"], str) or not 1 <= len(source["displayName"].strip()) <= 200:
                raise ValueError(f"{name} requires strict manual source configuration")
        if not isinstance(spec.get("network"), str) or not spec["network"] or not isinstance(spec.get("subnetwork"), str) or not spec["subnetwork"] or spec.get("egress") != "all-traffic":
            raise ValueError(f"{name} requires Direct VPC egress through the private network")
        if not isinstance(spec.get("max_instances"), int) or spec["max_instances"] < 1:
            raise ValueError(f"{name} requires a bounded max_instances")
        if not isinstance(spec.get("concurrency"), int) or spec["concurrency"] < 1:
            raise ValueError(f"{name} requires bounded concurrency")
    receipts = plan.get("build_receipt", {})
    if not isinstance(receipts, dict):
        raise ValueError("build_receipt must be an object")
    for name in selected:
        receipt = receipts.get(name)
        image = services[name]["image"]
        if not isinstance(receipt, dict) or receipt.get("image") != image or receipt.get("image_digest") != image.rsplit("@", 1)[1] or receipt.get("source_commit") != plan["source_commit"]:
            raise ValueError(f"{name} needs the verified build receipt for its selected immutable image")


def revision_digest(spec: dict[str, Any]) -> str:
    return canonical_digest({key: spec[key] for key in ("image", "service_account", "environment", "secrets", "resources", "max_instances", "concurrency", "network", "subnetwork", "egress")})


def select_mutations(plan: dict[str, Any], current: dict[str, Any], observed: dict[str, str]) -> list[dict[str, Any]]:
    validate_plan(plan)
    if current.get("generation") != plan.get("expected_generation"):
        raise ValueError("Release manifest generation changed; re-plan before promotion")
    mutations = []
    for name in sorted(plan.get("deploy", {})):
        previous = current.get("services", {}).get(name, {})
        expected = previous.get("revision_digest")
        if expected and observed.get(name) != expected:
            raise ValueError(f"Manual configuration drift for {name}; review it before promotion")
        mutations.append({"name": name, "kind": UNITS[name], "strategy": "stage-then-promote" if UNITS[name] == "service" else "replace-without-execute", "revision_digest": revision_digest(plan["services"][name])})
    return mutations


def run(args: list[str], *, capture: bool = False) -> str:
    result = subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout if capture else ""


def observed_revision_digests(project: str, region: str, names: list[str]) -> dict[str, str]:
    result = {}
    for name in names:
        try:
            document = json.loads(run(["gcloud", "run", "services", "describe", name, "--project", project, "--region", region, "--format=json"], capture=True))
        except subprocess.CalledProcessError:
            continue
        labels = document.get("spec", {}).get("template", {}).get("metadata", {}).get("labels", {})
        result[name] = labels.get("knowledge.carbon/revision-digest", "")
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


def revision_document(name: str, spec: dict[str, Any], digest: str) -> dict[str, Any]:
    environment = [{"name": key, "value": value} for key, value in sorted(spec["environment"].items())]
    environment += [{"name": key, "valueFrom": {"secretKeyRef": {"name": secret_reference(value)[0], "key": secret_reference(value)[1]}}} for key, value in sorted(spec["secrets"].items())]
    template = {
        "metadata": {
            "labels": {"knowledge.carbon/revision-digest": digest},
            "annotations": {
                "run.googleapis.com/network-interfaces": json.dumps([{"network": spec["network"], "subnetwork": spec["subnetwork"]}], separators=(",", ":")),
                "run.googleapis.com/vpc-access-egress": spec["egress"],
            },
        },
        "spec": {
            "serviceAccountName": spec["service_account"], "containerConcurrency": spec["concurrency"],
            "containers": [{"image": spec["image"], "env": environment, "resources": {"limits": spec["resources"]}}],
        },
    }
    if spec["kind"] == "job":
        return {"apiVersion": "run.googleapis.com/v1", "kind": "Job", "metadata": {"name": name}, "spec": {"template": {"template": template}}}
    template["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = str(spec["max_instances"])
    return {"apiVersion": "serving.knative.dev/v1", "kind": "Service", "metadata": {"name": name}, "spec": {"template": template}}


def save_manifest(path: Path, plan: dict[str, Any], current: dict[str, Any], mutations: list[dict[str, Any]]) -> None:
    services = dict(current.get("services", {}))
    for mutation in mutations:
        services[mutation["name"]] = {
            "revision_digest": mutation["revision_digest"],
            "image_digest": plan["services"][mutation["name"]]["image"].rsplit("@", 1)[1],
            "deployed_revision": mutation.get("deployed_revision"),
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as stream:
        json.dump({"generation": plan["generation"], "services": services}, stream, sort_keys=True)
        stream.write("\n")
        temporary = Path(stream.name)
    temporary.chmod(0o600)
    temporary.replace(path)


def promote(plan: dict[str, Any], current: dict[str, Any], *, project: str, region: str, manifest: Path, adapter: Gcloud) -> list[dict[str, Any]]:
    selected = sorted(plan.get("deploy", {}))
    observed_documents: dict[str, dict[str, Any]] = {}
    observed = {}
    for name in selected:
        try:
            document = json.loads(adapter.call(["gcloud", "run", "services", "describe", name, "--project", project, "--region", region, "--format=json"], capture=True))
        except subprocess.CalledProcessError:
            continue
        observed_documents[name] = document
        observed[name] = document.get("spec", {}).get("template", {}).get("metadata", {}).get("labels", {}).get("knowledge.carbon/revision-digest", "")
    mutations = select_mutations(plan, current, observed)
    promoted: list[dict[str, Any]] = []
    for mutation in mutations:
        name, spec = mutation["name"], plan["services"][mutation["name"]]
        document = revision_document(name, spec, mutation["revision_digest"])
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as stream:
            json.dump(document, stream)
            rendered = Path(stream.name)
        try:
            command = ["gcloud", "run", "jobs" if mutation["kind"] == "job" else "services", "replace", "--file", str(rendered), "--project", project, "--region", region]
            if mutation["kind"] == "service": command.append("--no-traffic")
            adapter.call(command)
            if mutation["kind"] == "service":
                ready = json.loads(adapter.call(["gcloud", "run", "services", "describe", name, "--project", project, "--region", region, "--format=json"], capture=True))
                conditions = ready.get("status", {}).get("conditions", [])
                if not any(condition.get("type") == "Ready" and condition.get("status") == "True" for condition in conditions):
                    raise ValueError(f"{name} staged revision did not become Ready")
                url = ready.get("status", {}).get("url")
                if not isinstance(url, str) or not url.startswith("https://"):
                    raise ValueError(f"{name} staged revision has no HTTPS service URL")
                token = adapter.call(["gcloud", "auth", "print-identity-token", f"--audiences={url}", f"--impersonate-service-account={spec['service_account']}"], capture=True).strip()
                if not token:
                    raise ValueError(f"Could not obtain an identity token for {name} health probe")
                adapter.call(["curl", "--fail", "--silent", "--show-error", "--max-time", "20", "--header", f"Authorization: Bearer {token}", url + "/health"])
                adapter.call(["gcloud", "run", "services", "update-traffic", name, "--to-latest", "--project", project, "--region", region])
                mutation["deployed_revision"] = ready.get("status", {}).get("latestReadyRevisionName")
                if not mutation["deployed_revision"]:
                    raise ValueError(f"{name} staged revision did not expose its immutable revision name")
            else:
                replaced = json.loads(adapter.call(["gcloud", "run", "jobs", "describe", name, "--project", project, "--region", region, "--format=json"], capture=True))
                mutation["deployed_revision"] = str(replaced.get("metadata", {}).get("generation", ""))
                if not mutation["deployed_revision"]:
                    raise ValueError(f"{name} replacement did not expose its observed generation")
            promoted.append(mutation)
        except Exception:
            prior = observed_documents.get(name, {}).get("status", {}).get("traffic", [])
            prior_revision = next((entry.get("revisionName") for entry in prior if entry.get("percent") == 100), None)
            if mutation["kind"] == "service" and prior_revision:
                adapter.call(["gcloud", "run", "services", "update-traffic", name, f"--to-revisions={prior_revision}=100", "--project", project, "--region", region])
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
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    plan, current = json.loads(args.plan.read_text()), json.loads(args.current.read_text())
    selected = sorted(plan.get("deploy", {}))
    mutations = select_mutations(plan, current, observed_revision_digests(args.project, args.region, selected) if args.apply else {name: current.get("services", {}).get(name, {}).get("revision_digest", "") for name in selected})
    if not args.apply:
        print(json.dumps({"mutations": mutations}, indent=2))
        return
    promoted = promote(plan, current, project=args.project, region=args.region, manifest=args.current, adapter=Gcloud())
    print(json.dumps({"promoted": promoted}, indent=2))


if __name__ == "__main__":
    main()
