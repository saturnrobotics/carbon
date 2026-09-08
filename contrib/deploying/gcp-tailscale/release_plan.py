#!/usr/bin/env python3
"""Pure, offline planner for independently deployable Carbon services.

The input and output documents deliberately contain only content digests, secret
versions, and public source URLs.  The last successful manifest is an operator
artifact; do not put it in the repository or CI logs.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from typing import Any


SCHEMA_VERSION = 1
BUILD_INPUTS = ("source", "workspaces", "lockfile", "catalog", "generators", "assets", "build_config", "base_image_digest")
IGNORED_CLOSURE_PARTS = {".git", "node_modules", "build", "dist", ".turbo", "__pycache__"}


def digest(value: Any) -> str:
    """Return a stable content address for JSON-compatible desired inputs."""
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def repository_closure(repo: Path, owned_paths: list[str]) -> dict[str, str]:
    """Hash the actual declared source closure, refusing paths outside the repo."""
    result: dict[str, str] = {}
    root = repo.resolve()
    for relative in sorted(set(owned_paths)):
        candidate = (root / relative).resolve()
        if candidate == root or root not in candidate.parents or not candidate.exists():
            raise ValueError(f"Unknown input ownership for {relative}; path must exist below the repository")
        paths = [candidate] if candidate.is_file() or candidate.is_symlink() else [
            path for path in candidate.rglob("*") if path.is_file() or path.is_symlink()
        ]
        for path in paths:
            if any(part in IGNORED_CLOSURE_PARTS for part in path.relative_to(root).parts):
                continue
            content = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
            result[str(path.relative_to(root))] = "sha256:" + hashlib.sha256(content).hexdigest()
    return result


def _turbo_binary(repo: Path) -> Path:
    binary = repo / "node_modules" / ".bin" / "turbo"
    if not binary.is_file():
        raise ValueError("Turbo is not installed; workspace release closure cannot be proven")
    return binary


def _catalog(repo: Path) -> dict[str, str]:
    """Read the flat default pnpm catalog without introducing a YAML dependency."""
    result: dict[str, str] = {}
    in_catalog = False
    for raw in (repo / "pnpm-workspace.yaml").read_text().splitlines():
        if raw == "catalog:":
            in_catalog = True
            continue
        if in_catalog and raw and not raw.startswith(" "):
            break
        if not in_catalog or not raw.startswith("  ") or ":" not in raw:
            continue
        name, value = raw.strip().split(":", 1)
        result[name.strip("'\"")] = value.strip().strip("'\"")
    return result


def _used_catalog(repo: Path, pruned: Path) -> dict[str, str]:
    catalog = _catalog(repo)
    used: set[str] = set()
    for manifest in pruned.glob("**/package.json"):
        package = json.loads(manifest.read_text())
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            for name, version in package.get(section, {}).items():
                if version == "catalog:":
                    used.add(name)
    missing = sorted(name for name in used if name not in catalog)
    if missing:
        raise ValueError("Pruned workspace uses missing catalog entries: " + ", ".join(missing))
    return {name: catalog[name] for name in sorted(used)}


def pruned_lock_content(lockfile: Path) -> bytes:
    """Exclude the unpruned catalog block; used entries are fingerprinted separately."""
    output: list[str] = []
    skipping_catalog = False
    for line in lockfile.read_text().splitlines(keepends=True):
        if line.rstrip() == "catalogs:":
            skipping_catalog = True
            continue
        if skipping_catalog and line.strip() and not line.startswith((" ", "\t")):
            skipping_catalog = False
        if not skipping_catalog:
            output.append(line)
    return "".join(output).encode()


def _task_inputs(task: dict[str, Any]) -> dict[str, str]:
    inputs = task.get("inputs", {})
    if not isinstance(inputs, dict):
        raise ValueError("Turbo dry-run returned invalid task inputs")
    return {
        path: value
        for path, value in sorted(inputs.items())
        if not any(part in IGNORED_CLOSURE_PARTS for part in Path(path).parts)
    }


def turbo_workspace_closure(repo: Path, workspace: str, task: str = "build") -> dict[str, Any]:
    """Materialize Turbo's real package, task, and pruned-lock closure for one app."""
    if not workspace or any(character.isspace() for character in workspace):
        raise ValueError("workspace must be a non-empty package name")
    root = repo.resolve()
    binary = _turbo_binary(root)
    with tempfile.TemporaryDirectory(prefix="carbon-release-prune-") as directory:
        pruned = Path(directory)
        try:
            subprocess.run(
                [str(binary), "prune", workspace, "--docker", f"--out-dir={pruned}"],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            )
            dry = subprocess.run(
                [str(binary), "run", task, f"--filter={workspace}", "--dry=json"],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as error:
            diagnostic = (error.stderr or error.stdout or "Turbo failed").strip().splitlines()[-1]
            raise ValueError(f"Unable to prove workspace closure for {workspace}: {diagnostic}") from error
        graph = json.loads(dry.stdout)
        tasks = graph.get("tasks", [])
        selected = [entry for entry in tasks if entry.get("package") == workspace and entry.get("task") == task]
        if len(selected) != 1:
            raise ValueError(f"Turbo did not resolve exactly one {workspace}#{task} task")
        target = selected[0]
        dependency_ids = set(target.get("dependencies", []))
        by_id = {entry.get("taskId"): entry for entry in tasks}
        pending = list(dependency_ids)
        while pending:
            task_id = pending.pop()
            entry = by_id.get(task_id)
            if not entry:
                continue
            for dependency in entry.get("dependencies", []):
                if dependency not in dependency_ids:
                    dependency_ids.add(dependency)
                    pending.append(dependency)
        dependencies = [by_id[task_id] for task_id in sorted(dependency_ids) if task_id in by_id]
        root_tasks = [entry for entry in dependencies if entry.get("package") == "//"]
        workspace_tasks = [entry for entry in dependencies if entry.get("package") != "//"]
        target_inputs = _task_inputs(target)
        asset_inputs = {
            path: value
            for path, value in target_inputs.items()
            if path.startswith(("public/", "assets/"))
        }
        source_inputs = {path: value for path, value in target_inputs.items() if path not in asset_inputs}
        lockfile = pruned / "json" / "pnpm-lock.yaml"
        if not lockfile.is_file():
            raise ValueError("Turbo prune did not produce a pruned lockfile")
        package_manifests = sorted((pruned / "json").glob("**/package.json"))
        packages = {
            json.loads(path.read_text()).get("name", str(path.relative_to(pruned / "json"))):
            str(path.parent.relative_to(pruned / "json"))
            for path in package_manifests
        }
        return {
            "source": source_inputs,
            "workspaces": {
                entry["taskId"]: {
                    "inputs": _task_inputs(entry),
                    "dependencies": sorted(entry.get("dependencies", [])),
                }
                for entry in workspace_tasks
            },
            "lockfile": "sha256:" + hashlib.sha256(pruned_lock_content(lockfile)).hexdigest(),
            "catalog": _used_catalog(root, pruned / "json"),
            "generators": {
                entry["taskId"]: {
                    "inputs": _task_inputs(entry),
                    "dependencies": sorted(entry.get("dependencies", [])),
                }
                for entry in root_tasks
            },
            "assets": asset_inputs,
            "packages": packages,
            "workspace_directory": target.get("directory"),
        }


def materialize_repository_inputs(desired: dict[str, Any], repo: Path) -> dict[str, Any]:
    """Replace manual source summaries with real closures before planning a release."""
    result = copy.deepcopy(desired)
    owners = result.get("input_owners", {})
    if not isinstance(owners, dict) or not all(
        isinstance(path, str)
        and isinstance(names, list)
        and all(isinstance(name, str) for name in names)
        for path, names in owners.items()
    ):
        raise ValueError("input_owners must map repository paths to service-name lists")
    for name, service in result.get("services", {}).items():
        workspace = service.get("workspace")
        if workspace is not None:
            if not isinstance(workspace, str):
                raise ValueError(f"Service {name} workspace must be a package name")
            closure = turbo_workspace_closure(repo, workspace, service.get("task", "build"))
            for key in ("source", "workspaces", "lockfile", "catalog", "generators", "assets"):
                service["inputs"][key] = closure[key]
            build_paths = service.get("build_paths", ["Dockerfile"])
            if not isinstance(build_paths, list) or not all(isinstance(path, str) for path in build_paths):
                raise ValueError(f"Service {name} build_paths must be a list of repository paths")
            build_paths = sorted(set(build_paths + ["package.json", "pnpm-workspace.yaml", ".npmrc", "turbo.json"]))
            service["inputs"]["build_config"] = repository_closure(repo, build_paths)
            roots = [closure.get("workspace_directory"), *closure["packages"].values()]
            for path in sorted({path for path in roots if path and path != "."}):
                owners.setdefault(path.rstrip("/"), []).append(name)
            for task_entry in closure["generators"].values():
                for path in task_entry["inputs"]:
                    owners.setdefault(path, []).append(name)
            owners.setdefault("pnpm-lock.yaml", []).append(name)
            for path in build_paths:
                owners.setdefault(path.rstrip("/"), []).append(name)
            continue
        paths = service.get("owned_paths")
        if paths is None and all(key in service.get("inputs", {}) for key in BUILD_INPUTS):
            continue
        if not isinstance(paths, list) or not paths or not all(isinstance(path, str) for path in paths):
            raise ValueError(f"Service {name} requires non-empty owned_paths for repository planning")
        service["inputs"]["source"] = repository_closure(repo, paths)
        for path in paths:
            owners.setdefault(path.rstrip("/"), []).append(name)
    result["input_owners"] = {path: sorted(set(names)) for path, names in owners.items()}
    return result


def _reason(label: str, before: str | None, after: str) -> list[str]:
    return [f"{label} changed" if before else f"new service ({label})"] if before != after else []


def _service_fingerprints(service: dict[str, Any]) -> dict[str, str]:
    inputs = service.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError("Each service requires an inputs object")
    missing = [key for key in BUILD_INPUTS if key not in inputs]
    if missing:
        raise ValueError("Missing owned build inputs: " + ", ".join(missing))
    if not isinstance(service.get("runtime_config", {}), dict) or not isinstance(service.get("secret_versions", {}), dict):
        raise ValueError("runtime_config and secret_versions must be objects")
    return {
        "build": digest({key: inputs[key] for key in BUILD_INPUTS}),
        "config": digest(service["runtime_config"]),
        "secrets": digest(service["secret_versions"]),
        "migration": digest(service.get("migration")) if service.get("migration") else "",
    }


def build_fingerprint(service: dict[str, Any]) -> str:
    """Public name for the build-closure fingerprint recorded in a receipt."""
    return _service_fingerprints(service)["build"]


def _verified_image_digest(service: dict[str, Any], fingerprints: dict[str, str], previous: dict[str, Any] | None) -> str | None:
    if previous and previous.get("fingerprints", {}).get("build") == fingerprints["build"]:
        return previous.get("image_digest")
    receipt = service.get("build_receipt")
    if receipt is None:
        return None
    if not isinstance(receipt, dict) or receipt.get("build_fingerprint") != fingerprints["build"]:
        raise ValueError("Build receipt does not attest to this service build fingerprint")
    image = receipt.get("image_digest")
    if not isinstance(image, str) or not __import__("re").fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("Build receipt requires an actual immutable OCI image digest")
    return image


def _validate(desired: dict[str, Any]) -> None:
    if desired.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"Unsupported release schema version: {desired.get('schema_version')!r}")
    if not isinstance(desired.get("generation"), int) or desired["generation"] < 1:
        raise ValueError("generation must be a positive integer")
    services = desired.get("services")
    if not isinstance(services, dict) or not services:
        raise ValueError("services must be a non-empty object")
    owners = desired.get("input_owners", {})
    if not isinstance(owners, dict):
        raise ValueError("input_owners must be an object")
    for changed in desired.get("changed_inputs", []):
        if not any(changed == path or changed.startswith(path.rstrip("/") + "/") for path in owners):
            raise ValueError(f"Unknown input ownership for {changed}; add an explicit owner before release review")
    for name, service in services.items():
        if not isinstance(name, str) or not name:
            raise ValueError("Service names must be non-empty strings")
        if not isinstance(service, dict):
            raise ValueError(f"Service {name} must be an object")
        _service_fingerprints(service)
        for required in ("source_commit", "source_code_url"):
            if not isinstance(service.get(required), str) or not service[required]:
                raise ValueError(f"Service {name} requires {required}")


def _new_service(name: str, service: dict[str, Any], fingerprints: dict[str, str], previous: dict[str, Any] | None) -> dict[str, Any]:
    image_digest = _verified_image_digest(service, fingerprints, previous)
    config_digest = digest({"config": fingerprints["config"], "secrets": fingerprints["secrets"]})
    config_mount_path = previous.get("config_mount_path") if previous and previous.get("config_digest") == config_digest else "/var/lib/carbon/config/" + config_digest.removeprefix("sha256:") + ".json"
    return {
        # A global repository revision never rewrites an unaffected app's source
        # identity. Its own identity changes only with an actual build closure.
        "source_commit": previous.get("source_commit") if previous and previous.get("fingerprints", {}).get("build") == fingerprints["build"] else service["source_commit"],
        "source_code_url": previous.get("source_code_url") if previous and previous.get("fingerprints", {}).get("build") == fingerprints["build"] else service["source_code_url"],
        "image_digest": image_digest,
        "config_mount_path": config_mount_path,
        "config_digest": config_digest,
        "fingerprints": fingerprints,
        "migration": service.get("migration"),
        # The controller compares this with the active Compose definition before
        # replacing it. It never treats a hand edit as permission to overwrite.
        "observed_config_digest": previous.get("config_digest", "") if previous else "",
    }


def plan(desired: dict[str, Any], last_successful: dict[str, Any]) -> dict[str, Any]:
    """Plan a release without reading the repository, cloud, or private state."""
    _validate(desired)
    if not isinstance(last_successful, dict):
        raise ValueError("last_successful must be an object")
    previous_services = last_successful.get("services", {})
    if not isinstance(previous_services, dict):
        raise ValueError("last_successful.services must be an object")
    output: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "expected_generation": last_successful.get("generation", 0),
        "generation": desired["generation"],
        "services": {}, "build": {}, "configure": {}, "migrate": {}, "deploy": {}, "unchanged": {},
    }
    for name, service in sorted(desired["services"].items()):
        previous = previous_services.get(name)
        fingerprints = _service_fingerprints(service)
        current = _new_service(name, service, fingerprints, previous)
        output["services"][name] = current
        old_fingerprints = previous.get("fingerprints", {}) if previous else {}
        migration = service.get("migration")
        if migration is not None:
            if not isinstance(migration, dict) or not isinstance(migration.get("version"), str) or not isinstance(migration.get("compatible_with", []), list):
                raise ValueError(f"Service {name} migration requires version and compatible_with")
            prior_version = (previous or {}).get("migration", {}).get("version") if isinstance((previous or {}).get("migration"), dict) else None
            if prior_version and prior_version not in migration["compatible_with"]:
                raise ValueError(f"Migration for {name} is not compatible with deployed schema {prior_version}")
        build_reasons = _reason("build inputs", old_fingerprints.get("build"), fingerprints["build"])
        configure_reasons = _reason("runtime configuration", old_fingerprints.get("config"), fingerprints["config"])
        configure_reasons += _reason("pinned secret versions", old_fingerprints.get("secrets"), fingerprints["secrets"])
        migration_reasons = _reason("migration", old_fingerprints.get("migration"), fingerprints["migration"]) if fingerprints["migration"] else []
        if build_reasons:
            output["build"][name] = build_reasons
        if configure_reasons:
            output["configure"][name] = configure_reasons
        if migration_reasons:
            output["migrate"][name] = migration_reasons
        if build_reasons or configure_reasons or migration_reasons:
            output["deploy"][name] = [*build_reasons, *configure_reasons, *migration_reasons]
        else:
            output["unchanged"][name] = ["all owned content, config, and secret versions unchanged"]
    for name in sorted(set(previous_services) - set(desired["services"])):
        output["deploy"][name] = ["service removed by reviewed desired manifest"]
    return output


def rollback_plan(base: dict[str, Any], failed: dict[str, Any]) -> dict[str, Any]:
    """Return a service-only rollback; stateful data is intentionally excluded."""
    base_services = base.get("services", {})
    failed_services = failed.get("services", {})
    deploy = {
        name: ["restore last successful compatible service image/config"]
        for name in failed.get("deploy", {}) if name in base_services and name in failed_services
    }
    return {"schema_version": SCHEMA_VERSION, "expected_generation": failed.get("generation"), "generation": failed.get("generation", 0) + 1, "services": base_services, "build": {}, "configure": {}, "migrate": {}, "deploy": deploy, "unchanged": {}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desired", type=Path)
    parser.add_argument("last_successful", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--repo", type=Path, help="hash declared service closures from this checkout")
    args = parser.parse_args()
    desired = json.loads(args.desired.read_text())
    if args.repo:
        desired = materialize_repository_inputs(desired, args.repo)
    result = plan(desired, json.loads(args.last_successful.read_text()))
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
