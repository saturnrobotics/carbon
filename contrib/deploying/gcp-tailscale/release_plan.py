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
import re
from pathlib import Path
import subprocess
import tempfile
from typing import Any


SCHEMA_VERSION = 1
# Bump whenever build-closure ownership or hashing semantics change, even when
# the receipt schema stays compatible. Older evidence must trigger a fresh build.
BUILD_INPUT_VERSION = 1
BUILD_INPUTS = (
    "source",
    "workspaces",
    "lockfile",
    "catalog",
    "generators",
    "assets",
    "build_config",
    "base_image_digest",
)
IGNORED_CLOSURE_PARTS = {
    ".git",
    "node_modules",
    "build",
    "dist",
    ".turbo",
    "__pycache__",
}


def digest(value: Any) -> str:
    """Return a stable content address for JSON-compatible desired inputs."""
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def repository_closure(repo: Path, owned_paths: list[str]) -> dict[str, str]:
    """Hash the actual declared source closure, refusing paths outside the repo."""
    result: dict[str, str] = {}
    root = repo.resolve()
    for relative in sorted(set(owned_paths)):
        candidate = root / relative
        if (
            Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or candidate == root
            or root not in candidate.parents
            or not (candidate.exists() or candidate.is_symlink())
        ):
            raise ValueError(
                f"Unknown input ownership for {relative}; path must exist below the repository"
            )
        resolved = candidate.resolve()
        if resolved == root or root not in resolved.parents:
            raise ValueError(f"Owned input escapes outside the repository: {relative}")
        paths = (
            [candidate]
            if candidate.is_file() or candidate.is_symlink()
            else [
                path
                for path in candidate.rglob("*")
                if path.is_file() or path.is_symlink()
            ]
        )
        for path in paths:
            if any(
                part in IGNORED_CLOSURE_PARTS for part in path.relative_to(root).parts
            ):
                continue
            resolved = path.resolve()
            if resolved == root or root not in resolved.parents:
                raise ValueError(
                    f"Owned input escapes outside the repository: {path.relative_to(root)}"
                )
            if path.is_symlink():
                identity = {"kind": "symlink", "target": os.readlink(path)}
            else:
                identity = {
                    "kind": "file",
                    "executable": bool(path.stat().st_mode & 0o111),
                    "content": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            result[str(path.relative_to(root))] = digest(identity)
    return result


def _tracked_package_inputs(repo: Path, directories: list[str]) -> dict[str, str]:
    """Package source reaches the image even when its build task lists fewer inputs.

    Use tracked source, not local node_modules, generated caches or private files.
    Declared generators independently account for rebuilt, untracked outputs.
    """
    if not directories:
        return {}
    names = (
        subprocess.check_output(
            ["git", "ls-files", "-z", "--", *sorted(set(directories))], cwd=repo
        )
        .decode()
        .split("\0")
    )
    result = {}
    for name in names:
        if not name or any(part in IGNORED_CLOSURE_PARTS for part in Path(name).parts):
            continue
        path = repo / name
        if path.is_symlink():
            result[name] = digest({"mode": "symlink", "target": os.readlink(path)})
        elif path.is_file():
            result[name] = digest(
                {
                    "executable": bool(path.stat().st_mode & 0o111),
                    "content": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            )
    return result


def _turbo_binary(repo: Path) -> Path:
    binary = repo / "node_modules" / ".bin" / "turbo"
    if not binary.is_file():
        raise ValueError(
            "Turbo is not installed; workspace release closure cannot be proven"
        )
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
        for section in (
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
        ):
            for name, version in package.get(section, {}).items():
                if version == "catalog:":
                    used.add(name)
    missing = sorted(name for name in used if name not in catalog)
    if missing:
        raise ValueError(
            "Pruned workspace uses missing catalog entries: " + ", ".join(missing)
        )
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


def _effective_root_manifest(
    manifest: dict[str, Any], workspace: str, root_tasks: list[dict[str, Any]]
) -> dict[str, Any]:
    """Retain installed dependencies and policy; select commands actually invoked."""
    result = copy.deepcopy(manifest)
    scripts = result.get("scripts", {})
    selected = {"build:" + workspace, *(entry["task"] for entry in root_tasks)}
    pending = list(selected)
    while pending:
        name = pending.pop()
        for hook in ("pre" + name, "post" + name):
            if hook in scripts and hook not in selected:
                selected.add(hook)
                pending.append(hook)
        for called in re.findall(
            r"(?:pnpm|npm)\s+(?:run\s+)?([\w:-]+)", scripts.get(name, "")
        ):
            if called in scripts and called not in selected:
                selected.add(called)
                pending.append(called)
    result["scripts"] = {
        name: scripts[name] for name in sorted(selected) if name in scripts
    }
    for metadata in ("lint-staged", "crbn"):
        result.pop(metadata, None)
    return result


def _workspace_policy(path: Path) -> str:
    """Catalog versions are owned through actual consumers and the pruned lock."""
    result = []
    in_catalog = False
    for line in path.read_text().splitlines():
        if line in ("catalog:", "catalogs:"):
            in_catalog = True
            continue
        if in_catalog and line.strip() and not line.startswith((" ", "\t", "#")):
            in_catalog = False
        if not in_catalog and line.strip() and not line.lstrip().startswith("#"):
            result.append(line.rstrip())
    return "\n".join(result)


def _task_definition(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        key: entry.get(key)
        for key in (
            "command",
            "resolvedTaskDefinition",
            "environmentVariables",
            "envMode",
        )
    }


def turbo_workspace_closure(
    repo: Path, workspace: str, task: str = "build"
) -> dict[str, Any]:
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
            diagnostic = (
                (error.stderr or error.stdout or "Turbo failed")
                .strip()
                .splitlines()[-1]
            )
            raise ValueError(
                f"Unable to prove workspace closure for {workspace}: {diagnostic}"
            ) from error
        graph = json.loads(dry.stdout)
        tasks = graph.get("tasks", [])
        selected = [
            entry
            for entry in tasks
            if entry.get("package") == workspace and entry.get("task") == task
        ]
        if len(selected) != 1:
            raise ValueError(
                f"Turbo did not resolve exactly one {workspace}#{task} task"
            )
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
        dependencies = [
            by_id[task_id] for task_id in sorted(dependency_ids) if task_id in by_id
        ]
        root_tasks = [entry for entry in dependencies if entry.get("package") == "//"]
        workspace_tasks = [
            entry for entry in dependencies if entry.get("package") != "//"
        ]
        target_inputs = _task_inputs(target)
        asset_inputs = {
            path: value
            for path, value in target_inputs.items()
            if path.startswith(("public/", "assets/"))
        }
        source_inputs = {
            path: value
            for path, value in target_inputs.items()
            if path not in asset_inputs
        }
        lockfile = pruned / "json" / "pnpm-lock.yaml"
        if not lockfile.is_file():
            raise ValueError("Turbo prune did not produce a pruned lockfile")
        package_manifests = sorted((pruned / "json").glob("**/package.json"))
        packages = {
            json.loads(path.read_text()).get(
                "name", str(path.relative_to(pruned / "json"))
            ): str(path.parent.relative_to(pruned / "json"))
            for path in package_manifests
        }
        root_manifest = _effective_root_manifest(
            json.loads((pruned / "json/package.json").read_text()),
            workspace,
            root_tasks,
        )
        patch_paths = list(
            root_manifest.get("pnpm", {}).get("patchedDependencies", {}).values()
        )
        command_paths = sorted(
            {
                path
                for command in root_manifest.get("scripts", {}).values()
                for path in re.findall(
                    r"(?:^|\s)(?:\./)?((?:scripts|docs/scripts)/[\w./-]+)", command
                )
            }
        )
        # Root generators can import sibling helpers not listed in their task
        # inputs. Retain their complete tracked script area for actual consumers.
        # This is deliberately conservative within that area, not across all apps.
        script_inputs = [
            *command_paths,
            *(path for entry in root_tasks for path in _task_inputs(entry)),
        ]
        script_roots = sorted(
            {
                "docs" if path.startswith("docs/scripts/") else "scripts"
                for path in script_inputs
                if path.startswith(("scripts/", "docs/scripts/"))
            }
        )
        return {
            "configuration": {
                "package.json": root_manifest,
                "pnpm-workspace.yaml": _workspace_policy(
                    pruned / "json/pnpm-workspace.yaml"
                ),
                "turbo.json": {
                    entry["taskId"]: _task_definition(entry)
                    for entry in [target, *dependencies]
                },
                "global_inputs": graph.get("globalCacheInputs", {}).get("files", {}),
                "global_environment": graph.get("globalCacheInputs", {}).get(
                    "environmentVariables", {}
                ),
                "patches": repository_closure(root, patch_paths),
                "commands": {
                    **repository_closure(root, command_paths),
                    **_tracked_package_inputs(root, script_roots),
                },
            },
            "source": source_inputs,
            "workspaces": {
                entry["taskId"]: {
                    "inputs": _task_inputs(entry),
                    "dependencies": sorted(entry.get("dependencies", [])),
                }
                for entry in workspace_tasks
            }
            | {
                "bundled_files": _tracked_package_inputs(
                    root, [path for path in packages.values() if path and path != "."]
                )
            },
            "lockfile": "sha256:"
            + hashlib.sha256(pruned_lock_content(lockfile)).hexdigest(),
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


def classify_repository_changes(
    repo: Path, revision: str, previous: dict[str, Any]
) -> dict[str, Any]:
    """Audit the full deployed-to-candidate Git delta, including merge resolutions.

    Known repository areas can be outside an application's actual Turbo closure.
    Infrastructure under contrib is independently fingerprinted by preparation.
    A new top-level input requires an explicit ownership decision, never silence.
    """
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Repository input audit requires a full candidate commit")
    base = previous.get("prepared_source_commit")
    if base is not None and (
        not isinstance(base, str) or not re.fullmatch(r"[a-f0-9]{40}", base)
    ):
        raise ValueError("Previous release has an invalid prepared_source_commit")
    command = (
        ["git", "diff", "--no-renames", "--name-only", "-z", base, revision, "--"]
        if base
        else ["git", "ls-tree", "-rz", "--name-only", revision]
    )
    try:
        changed = (
            subprocess.check_output(command, cwd=repo, stderr=subprocess.PIPE)
            .decode()
            .split("\0")
        )
    except subprocess.CalledProcessError:
        raise ValueError(
            "Cannot audit deployed source history; fetch the recorded deployment commit before release review"
        ) from None
    known_areas = (
        ".ai",
        ".claude",
        ".conductor",
        ".fork",
        ".github",
        ".husky",
        "apps",
        "packages",
        "ci",
        "contrib",
        "crates",
        "docs",
        "patches",
        "scripts",
        ".dockerignore",
        ".env.example",
        ".gitattributes",
        ".gitignore",
        ".npmrc",
        ".nvmrc",
        "AGENTS.md",
        "BACKWARD_COMPATIBILITY.md",
        "CLAUDE.md",
        "Cargo.lock",
        "Cargo.toml",
        "Dockerfile",
        "LICENSE",
        "NOTICE",
        "Makefile",
        "README.md",
        "biome.jsonc",
        "lingui.config.js",
        "mise.toml",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "setup.sh",
        "sst-env.d.ts",
        "sst.config.ts",
        "tsconfig.json",
        "turbo.json",
    )
    owners = {path: [] for path in known_areas}
    owners.update(copy.deepcopy(previous.get("input_owners", {})))
    return {
        "changed_inputs": sorted(path for path in changed if path),
        "input_owners": owners,
    }


def materialize_repository_inputs(
    desired: dict[str, Any], repo: Path, previous: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Replace manual source summaries with real closures before planning a release."""
    result = copy.deepcopy(desired)
    owners = copy.deepcopy((previous or {}).get("input_owners", {}))
    owners.update(result.get("input_owners", {}))
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
            closure = turbo_workspace_closure(
                repo, workspace, service.get("task", "build")
            )
            for key in (
                "source",
                "workspaces",
                "lockfile",
                "catalog",
                "generators",
                "assets",
            ):
                service["inputs"][key] = closure[key]
            build_paths = service.get("build_paths", ["Dockerfile"])
            if not isinstance(build_paths, list) or not all(
                isinstance(path, str) for path in build_paths
            ):
                raise ValueError(
                    f"Service {name} build_paths must be a list of repository paths"
                )
            normalized = {"package.json", "pnpm-workspace.yaml", "turbo.json"}
            build_paths = sorted(set(build_paths + [".npmrc"]) - normalized)
            service["inputs"]["build_config"] = {
                **repository_closure(repo, build_paths),
                **closure["configuration"],
            }
            roots = [closure.get("workspace_directory"), *closure["packages"].values()]
            for path in sorted({path for path in roots if path and path != "."}):
                owners.setdefault(path.rstrip("/"), []).append(name)
            for task_entry in closure["generators"].values():
                for path in task_entry["inputs"]:
                    owners.setdefault(path, []).append(name)
            owners.setdefault("pnpm-lock.yaml", []).append(name)
            for path in [
                *build_paths,
                *normalized,
                *closure["configuration"]["patches"],
                *closure["configuration"]["commands"],
                *closure["configuration"]["global_inputs"],
            ]:
                owners.setdefault(path.rstrip("/"), []).append(name)
            continue
        paths = service.get("owned_paths")
        if paths is None and all(
            key in service.get("inputs", {}) for key in BUILD_INPUTS
        ):
            continue
        if (
            not isinstance(paths, list)
            or not paths
            or not all(isinstance(path, str) for path in paths)
        ):
            raise ValueError(
                f"Service {name} requires non-empty owned_paths for repository planning"
            )
        service["inputs"]["source"] = repository_closure(repo, paths)
        for path in paths:
            owners.setdefault(path.rstrip("/"), []).append(name)
    result["input_owners"] = {
        path: sorted(set(names)) for path, names in owners.items()
    }
    return result


def _reason(label: str, before: str | None, after: str) -> list[str]:
    return (
        [f"{label} changed" if before else f"new service ({label})"]
        if before != after
        else []
    )


def _service_fingerprints(service: dict[str, Any]) -> dict[str, str]:
    inputs = service.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError("Each service requires an inputs object")
    missing = [key for key in BUILD_INPUTS if key not in inputs]
    if missing:
        raise ValueError("Missing owned build inputs: " + ", ".join(missing))
    if not isinstance(service.get("runtime_config", {}), dict) or not isinstance(
        service.get("secret_versions", {}), dict
    ):
        raise ValueError("runtime_config and secret_versions must be objects")
    return {
        "build": digest(
            {
                "version": BUILD_INPUT_VERSION,
                "inputs": {key: inputs[key] for key in BUILD_INPUTS},
            }
        ),
        "config": digest(service["runtime_config"]),
        "secrets": digest(service["secret_versions"]),
        "migration": digest(service.get("migration"))
        if service.get("migration")
        else "",
    }


def build_fingerprint(service: dict[str, Any]) -> str:
    """Public name for the build-closure fingerprint recorded in a receipt."""
    return _service_fingerprints(service)["build"]


def _can_reuse_build(
    previous: dict[str, Any] | None, fingerprints: dict[str, str]
) -> bool:
    return bool(
        previous
        and previous.get("build_input_version") == BUILD_INPUT_VERSION
        and previous.get("fingerprints", {}).get("build") == fingerprints["build"]
        and isinstance(previous.get("image_digest"), str)
        and re.fullmatch(r"sha256:[a-f0-9]{64}", previous["image_digest"])
    )


def _verified_image_digest(
    service: dict[str, Any],
    fingerprints: dict[str, str],
    previous: dict[str, Any] | None,
) -> str | None:
    if _can_reuse_build(previous, fingerprints):
        return previous.get("image_digest")
    receipt = service.get("build_receipt")
    if receipt is None:
        return None
    if (
        not isinstance(receipt, dict)
        or receipt.get("build_fingerprint") != fingerprints["build"]
    ):
        raise ValueError(
            "Build receipt does not attest to this service build fingerprint"
        )
    image = receipt.get("image_digest")
    if not isinstance(image, str) or not __import__("re").fullmatch(
        r"sha256:[a-f0-9]{64}", image
    ):
        raise ValueError("Build receipt requires an actual immutable image identity")
    return image


def _validate(desired: dict[str, Any]) -> None:
    if desired.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported release schema version: {desired.get('schema_version')!r}"
        )
    if not isinstance(desired.get("generation"), int) or desired["generation"] < 1:
        raise ValueError("generation must be a positive integer")
    services = desired.get("services")
    if not isinstance(services, dict) or not services:
        raise ValueError("services must be a non-empty object")
    owners = desired.get("input_owners", {})
    if not isinstance(owners, dict):
        raise ValueError("input_owners must be an object")
    for changed in desired.get("changed_inputs", []):
        if not any(
            changed == path or changed.startswith(path.rstrip("/") + "/")
            for path in owners
        ):
            raise ValueError(
                f"Unknown input ownership for {changed}; add an explicit owner before release review"
            )
    for name, service in services.items():
        if not isinstance(name, str) or not name:
            raise ValueError("Service names must be non-empty strings")
        if not isinstance(service, dict):
            raise ValueError(f"Service {name} must be an object")
        _service_fingerprints(service)
        for required in ("source_commit", "source_code_url"):
            if not isinstance(service.get(required), str) or not service[required]:
                raise ValueError(f"Service {name} requires {required}")


def _component_evidence(components: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Keep only hashed values in private receipts, with explanatory input paths."""
    evidence: dict[str, dict[str, str]] = {}

    def visit(value: Any, path: str, leaves: dict[str, str]) -> None:
        if isinstance(value, dict) and value:
            for key, child in sorted(value.items()):
                visit(child, path + "/" + key if path else key, leaves)
        else:
            leaves[path or "value"] = digest(value)

    for component, value in components.items():
        leaves: dict[str, str] = {}
        visit(value, "", leaves)
        evidence[component] = leaves
    return evidence


def _input_evidence(service: dict[str, Any]) -> dict[str, dict[str, str]]:
    return _component_evidence({key: service["inputs"][key] for key in BUILD_INPUTS})


def _evidence_changes(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    reasons = []
    for component, leaves in after.items():
        old = before.get(component, {})
        for path in sorted(set(old) | set(leaves)):
            if old.get(path) != leaves.get(path):
                action = (
                    "added"
                    if path not in old
                    else "deleted"
                    if path not in leaves
                    else "changed"
                )
                reasons.append(f"{component}: {path} {action}")
    return reasons


def _build_reasons(
    service: dict[str, Any],
    previous: dict[str, Any] | None,
    fingerprints: dict[str, str],
) -> list[str]:
    if _can_reuse_build(previous, fingerprints):
        return []
    if not previous:
        return ["new service (build inputs)"]
    if previous.get("build_input_version") != BUILD_INPUT_VERSION:
        return [
            "build input tracking version changed; rebuild to establish current evidence"
        ]
    if previous.get("fingerprints", {}).get("build") == fingerprints["build"]:
        return ["missing verified image identity; build required before reuse"]
    before = previous.get("input_evidence")
    if not isinstance(before, dict):
        return ["build inputs changed (previous receipt has no component evidence)"]
    return _evidence_changes(before, _input_evidence(service)) or [
        "build inputs changed (fingerprint format changed)"
    ]


def _new_service(
    name: str,
    service: dict[str, Any],
    fingerprints: dict[str, str],
    previous: dict[str, Any] | None,
) -> dict[str, Any]:
    image_digest = _verified_image_digest(service, fingerprints, previous)
    config_digest = digest(
        {"config": fingerprints["config"], "secrets": fingerprints["secrets"]}
    )
    config_mount_path = (
        previous.get("config_mount_path")
        if previous and previous.get("config_digest") == config_digest
        else "/var/lib/carbon/config/" + config_digest.removeprefix("sha256:") + ".json"
    )
    return {
        # A global repository revision never rewrites an unaffected app's source
        # identity. Its own identity changes only with an actual build closure.
        "source_commit": previous.get("source_commit")
        if _can_reuse_build(previous, fingerprints)
        else service["source_commit"],
        "source_code_url": previous.get("source_code_url")
        if _can_reuse_build(previous, fingerprints)
        else service["source_code_url"],
        "image_digest": image_digest,
        "config_mount_path": config_mount_path,
        "config_digest": config_digest,
        "fingerprints": fingerprints,
        "build_input_version": BUILD_INPUT_VERSION,
        "input_evidence": _input_evidence(service),
        "configuration_evidence": _component_evidence(
            {
                "runtime configuration": service["runtime_config"],
                "pinned secret versions": service["secret_versions"],
            }
        ),
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
        "input_owners": copy.deepcopy(desired.get("input_owners", {})),
        "services": {},
        "build": {},
        "configure": {},
        "migrate": {},
        "deploy": {},
        "unchanged": {},
    }
    if desired.get("prepared_source_commit"):
        output["prepared_source_commit"] = desired["prepared_source_commit"]
    for name, service in sorted(desired["services"].items()):
        previous = previous_services.get(name)
        fingerprints = _service_fingerprints(service)
        current = _new_service(name, service, fingerprints, previous)
        output["services"][name] = current
        old_fingerprints = previous.get("fingerprints", {}) if previous else {}
        migration = service.get("migration")
        if migration is not None:
            if (
                not isinstance(migration, dict)
                or not isinstance(migration.get("version"), str)
                or not isinstance(migration.get("compatible_with", []), list)
            ):
                raise ValueError(
                    f"Service {name} migration requires version and compatible_with"
                )
            prior_version = (
                (previous or {}).get("migration", {}).get("version")
                if isinstance((previous or {}).get("migration"), dict)
                else None
            )
            if prior_version and prior_version not in migration["compatible_with"]:
                raise ValueError(
                    f"Migration for {name} is not compatible with deployed schema {prior_version}"
                )
        build_reasons = _build_reasons(service, previous, fingerprints)
        configure_reasons = _reason(
            "runtime configuration",
            old_fingerprints.get("config"),
            fingerprints["config"],
        )
        configure_reasons += _reason(
            "pinned secret versions",
            old_fingerprints.get("secrets"),
            fingerprints["secrets"],
        )
        if (
            configure_reasons
            and previous
            and isinstance(previous.get("configuration_evidence"), dict)
        ):
            configure_reasons = (
                _evidence_changes(
                    previous["configuration_evidence"],
                    current["configuration_evidence"],
                )
                or configure_reasons
            )
        migration_reasons = (
            _reason(
                "migration",
                old_fingerprints.get("migration"),
                fingerprints["migration"],
            )
            if fingerprints["migration"]
            else []
        )
        if build_reasons:
            output["build"][name] = build_reasons
        if configure_reasons:
            output["configure"][name] = configure_reasons
        if migration_reasons:
            output["migrate"][name] = migration_reasons
        if build_reasons or configure_reasons or migration_reasons:
            output["deploy"][name] = [
                *build_reasons,
                *configure_reasons,
                *migration_reasons,
            ]
        else:
            output["unchanged"][name] = [
                "all owned content, config, and secret versions unchanged"
            ]
    for name in sorted(set(previous_services) - set(desired["services"])):
        output["deploy"][name] = ["service removed by reviewed desired manifest"]
    return output


def rollback_plan(base: dict[str, Any], failed: dict[str, Any]) -> dict[str, Any]:
    """Return a service-only rollback; stateful data is intentionally excluded."""
    base_services = base.get("services", {})
    failed_services = failed.get("services", {})
    deploy = {
        name: ["restore last successful compatible service image/config"]
        for name in failed.get("deploy", {})
        if name in base_services and name in failed_services
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "expected_generation": failed.get("generation"),
        "generation": failed.get("generation", 0) + 1,
        "services": base_services,
        "build": {},
        "configure": {},
        "migrate": {},
        "deploy": deploy,
        "unchanged": {},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desired", type=Path)
    parser.add_argument("last_successful", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--repo", type=Path, help="hash declared service closures from this checkout"
    )
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
