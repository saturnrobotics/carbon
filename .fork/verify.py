"""Inspect immutable Git evidence before running any dependency lifecycle scripts.

Preflight uses only Python and Git. Diagnostics contain paths/reasons, never file
contents, environment values, or credentials. Generation compares against a Git
snapshot captured before commands run, including when postinstall already ran.
"""

import argparse
import fnmatch
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REGISTRY = ".fork/generated-artifacts.json"
GROUPS = {"source", "knowledge", "schema", "schema-manifest", "build", "routes"}
LOCAL_INPUTS = (".env*", "apps/*/.env*", "packages/*/.env*", ".npmrc", ".pnpmfile.cjs")
MIGRATIONS = "packages/database/supabase/migrations/"
MARKER = re.compile(rb"^(?:<{7}|>{7})(?: |$)", re.MULTILINE)
PRIVATE_KEY = re.compile(
    rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"
)


def git(root, *args, input=None):
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        input=input,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise ValueError(f"Git operation failed: {args[0]} (exit {result.returncode})")
    return result.stdout


def snapshot(root: Path, revision: str):
    """Batch-read Git objects, so working-tree repairs cannot change the verdict."""
    if revision == "worktree":
        paths = git(root, "ls-files", "-co", "--exclude-standard", "-z").split(b"\0")
        result = {}
        for raw in paths:
            if not raw:
                continue
            name = os.fsdecode(raw)
            path = root / name
            if path.is_symlink():
                result[name] = os.readlink(path).encode()
            elif path.is_file():
                result[name] = path.read_bytes()
        return result
    if revision == "index":
        records = git(root, "ls-files", "--stage", "-z").split(b"\0")
    else:
        records = git(root, "ls-tree", "-rz", revision).split(b"\0")
    entries = []
    for record in records:
        if not record:
            continue
        metadata, path = record.split(b"\t", 1)
        fields = metadata.split()
        if revision == "index":
            if fields[2] != b"0":
                raise ValueError(
                    "Unresolved Git index entries; resolve source conflicts first"
                )
            oid = fields[1]
        else:
            if fields[1] != b"blob":
                continue
            oid = fields[2]
        entries.append((os.fsdecode(path), oid))
    data = (
        git(
            root,
            "cat-file",
            "--batch",
            input=b"\n".join(oid for _, oid in entries) + b"\n",
        )
        if entries
        else b""
    )
    pos = 0
    result = {}
    for path, _ in entries:
        end = data.index(b"\n", pos)
        size = int(data[pos:end].split()[2])
        result[path] = data[end + 1 : end + 1 + size]
        pos = end + size + 2
    return result


@lru_cache(maxsize=4096)
def expanded_glob(pattern):
    # Recursive directory globs also match zero directories, including in the
    # middle of a path. fnmatch alone does not implement that glob behavior.
    expanded = {pattern}
    for match in re.finditer(r"\*\*/", pattern):
        expanded.update(
            expanded_glob(pattern[: match.start()] + pattern[match.end() :])
        )
    return tuple(expanded)


def matches(path, patterns):
    return any(
        fnmatch.fnmatchcase(path, expanded)
        for pattern in patterns
        for expanded in expanded_glob(pattern)
    )


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("non-finite JSON number")

    return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)


def artifact_policy(data):
    registry = strict_json(data)
    if (
        not isinstance(registry, dict)
        or registry.get("version") != 1
        or not isinstance(registry.get("artifacts"), list)
    ):
        raise ValueError("unsupported registry")

    def strings(value, required=False, paths=False):
        if (
            not isinstance(value, list)
            or (required and not value)
            or any(not isinstance(v, str) or not v for v in value)
        ):
            raise ValueError("invalid registry list")
        if paths and any(v.startswith("/") or ".." in v.split("/") for v in value):
            raise ValueError("registry paths must stay in the repository")

    strings(registry.get("forbidden_tracked", []), paths=True)
    strings(registry.get("protected_local", []), paths=True)
    templates = registry.get("public_environment_templates", [])
    strings(templates, paths=True)
    if any(
        not re.fullmatch(
            r"\.env(?:rc)?(?:\.[A-Za-z0-9_*-]+)*\.example", Path(pattern).name
        )
        for pattern in templates
    ):
        raise ValueError("environment exceptions must name example templates")
    seen = set()
    scripts = set()
    for artifact in registry["artifacts"]:
        if not isinstance(artifact, dict):
            raise ValueError("invalid artifact")
        name = artifact.get("id")
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[a-z0-9-]+", name)
            or name in seen
        ):
            raise ValueError("invalid or duplicate artifact id")
        seen.add(name)
        kind = artifact.get("kind")
        if kind not in {
            "generated-contract",
            "build-output",
            "dependency-resolution",
            "authored-and-extracted",
        }:
            raise ValueError("invalid artifact kind")
        strings(artifact.get("inputs"), required=True, paths=True)
        for key in ("tracked", "untracked"):
            strings(artifact.get(key, []), paths=True)
        if not artifact.get("tracked") and not artifact.get("untracked"):
            raise ValueError("artifact output ownership is required")
        if kind in {"generated-contract", "build-output"}:
            strings(artifact.get("command"), required=True)
            if artifact.get("group") not in GROUPS:
                raise ValueError(
                    "generator group must have a required verification job"
                )
        if artifact.get("compare", "text") not in {"json", "text"}:
            raise ValueError("invalid generator comparison")
        strings(artifact.get("root_scripts", []))
        for script in artifact.get("root_scripts", []):
            if script in scripts:
                raise ValueError("generator script has multiple owners")
            scripts.add(script)
    for pair in registry.get("identical_copies", []):
        strings(pair, required=True, paths=True)
        if len(pair) != 2:
            raise ValueError("identical copies must contain two paths")
    return registry


def contains_private_key(value):
    """Recognize complete PEM blocks, including JSON and escaped source strings.

    Decode JSON with the existing strict parser; never evaluate source code.
    Outside JSON, normalize only literal CRLF/LF escapes for the same PEM test.
    """
    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            pending.extend(current)
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
        elif isinstance(current, (bytes, str)):
            data = (
                current.encode("utf-8", "surrogatepass")
                if isinstance(current, str)
                else current
            )
            normalized = data.replace(b"\\r\\n", b"\n").replace(b"\\n", b"\n")
            if PRIVATE_KEY.search(data) or PRIVATE_KEY.search(normalized):
                return True
    return False


def inspect(files, base_files=None, upstream_files=None):
    errors = []
    for path, data in files.items():
        if b"\0" not in data and MARKER.search(data):
            errors.append(f"{path}: unresolved conflict marker")
        private_key = contains_private_key(data)
        if path.endswith(".json"):
            try:
                private_key = contains_private_key(strict_json(data)) or private_key
            except (ValueError, UnicodeError):
                errors.append(f"{path}: invalid JSON (including duplicate keys)")
        if private_key:
            errors.append(
                f"{path}: tracked private key; remove from publication and review history"
            )
    try:
        registry = artifact_policy(files[REGISTRY])
    except (KeyError, TypeError, ValueError):
        return errors + [f"{REGISTRY}: missing or invalid artifact policy"]
    forbidden = list(registry.get("forbidden_tracked", []))
    for artifact in registry["artifacts"]:
        forbidden += artifact.get("untracked", [])
        for path in artifact.get("tracked", []):
            if not any(matches(candidate, [path]) for candidate in files):
                errors.append(f"{path}: required {artifact['id']} artifact missing")
    for path in files:
        if matches(path, forbidden):
            errors.append(f"{path}: forbidden tracked runtime/generated artifact")
        parts = Path(path).parts
        if any(part.startswith(".env") for part in parts[:-1]) or (
            parts[-1].startswith(".env")
            and not matches(path, registry.get("public_environment_templates", []))
        ):
            errors.append(
                f"{path}: tracked private environment input; publish a reviewed example template instead"
            )
    if "pnpm-lock.yaml" not in files:
        errors.append("pnpm-lock.yaml: required tracked dependency resolution missing")
    try:
        package = strict_json(files["package.json"])
        if not re.fullmatch(
            r"pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f0-9]+)?",
            package.get("packageManager", ""),
        ):
            errors.append("package.json: packageManager must pin an exact pnpm version")
        if "pnpm-lock.yaml" in package.get("scripts", {}).get("clean", ""):
            errors.append("package.json: clean must preserve pnpm-lock.yaml")
        registered = {
            script
            for a in registry["artifacts"]
            for script in a.get("root_scripts", [])
        }
        for script in package.get("scripts", {}):
            if (
                script.startswith("generate:") or script == "typegen"
            ) and script not in registered:
                errors.append(
                    f"package.json: unregistered generator {script}; declare inputs and output ownership"
                )
    except (KeyError, TypeError, ValueError):
        errors.append("package.json: missing or invalid dependency manifest")
    if (
        b".fork/agent-policy.md" not in files.get("AGENTS.md", b"")
        or ".fork/agent-policy.md" not in files
    ):
        errors.append("AGENTS.md: mandatory .fork/agent-policy.md routing missing")
    versions = {}
    for path in files:
        if path.startswith(MIGRATIONS) and path.endswith(".sql"):
            version = Path(path).name.split("_", 1)[0]
            if version in versions:
                errors.append(
                    f"{path}: duplicate migration version ({versions[version]})"
                )
            versions[version] = path
    if base_files is not None:
        for path, content in base_files.items():
            if (
                path.startswith(MIGRATIONS)
                and path.endswith(".sql")
                and files.get(path) != content
            ):
                errors.append(
                    f"{path}: historical migration changed or deleted; add a forward migration"
                )
    if upstream_files is not None:
        for path in files.keys() | upstream_files.keys():
            if (
                path.startswith(".ai/")
                and not path.startswith(".ai/scripts/")
                and not matches(path, forbidden)
                and files.get(path) != upstream_files.get(path)
            ):
                errors.append(
                    f"{path}: fork-owned record in upstream namespace; preserve it under .fork/"
                )
    for pair in registry.get("identical_copies", []):
        if files.get(pair[0]) != files.get(pair[1]):
            errors.append(f"{pair[0]} / {pair[1]}: generated copies differ")
    return errors


def preflight(
    root: Path,
    revision: str = "HEAD",
    base: str | None = None,
    upstream: str | None = None,
):
    candidate = "HEAD" if revision in {"index", "worktree"} else revision
    for ancestor in (base, upstream):
        if ancestor:
            git(root, "merge-base", "--is-ancestor", ancestor, candidate)
    return inspect(
        snapshot(root, revision),
        snapshot(root, base) if base else None,
        snapshot(root, upstream) if upstream else None,
    )


def canonical(data, kind):
    if kind == "json":
        return json.dumps(
            strict_json(data), sort_keys=True, separators=(",", ":")
        ).encode()
    return data.replace(b"\r\n", b"\n")


def output_files(root, patterns):
    # On Python <=3.12 a terminal ** yields directories, not their files.
    return {
        str(path.relative_to(root)): path
        for pattern in patterns
        for path in root.glob(pattern + "/*" if pattern.endswith("/**") else pattern)
        if path.is_file()
    }


def protected_inputs(root, registry):
    return {
        name: hashlib.sha256(path.read_bytes()).digest()
        for name, path in output_files(
            root, [*LOCAL_INPUTS, *registry.get("protected_local", [])]
        ).items()
    }


def generated(root, revision="HEAD", groups=None, run=None):
    before = snapshot(root, revision)
    registry = artifact_policy(before[REGISTRY])
    selected = groups or ["source"]
    if any(group in {"schema", "schema-manifest"} for group in selected):
        raise ValueError(
            "Schema groups require .fork/schema.py disposable verification"
        )
    available = {a.get("group") for a in registry["artifacts"] if a.get("command")}
    if any(group not in available for group in selected):
        raise ValueError("Unknown or empty generator group")
    working = snapshot(root, "worktree")
    outputs = [
        p
        for a in registry["artifacts"]
        for p in a.get("tracked", []) + a.get("untracked", [])
        if a.get("command") and a.get("group") in selected
    ]
    for path in before.keys() | working.keys():
        if not matches(path, outputs) and before.get(path) != working.get(path):
            raise ValueError(f"Working source does not match {revision}: {path}")
    errors = []
    run = run or (lambda command: subprocess.run(command, cwd=root, check=True))
    artifacts = [a for a in registry["artifacts"] if a.get("group") in selected]

    def captured_outputs():
        return {
            a["id"]: {
                name: canonical(
                    path.read_bytes(),
                    a.get("compare", "json" if name.endswith(".json") else "text"),
                )
                for name, path in output_files(
                    root, a.get("tracked", []) + a.get("untracked", [])
                ).items()
            }
            for a in artifacts
        }

    passes = []
    # Repeat the entire ordered pipeline. Repeating one generator immediately
    # misses stale inputs repaired by a later generator in the same pipeline.
    for _ in range(2):
        for artifact in artifacts:
            inputs_before = snapshot(root, "worktree")
            local_before = protected_inputs(root, registry)
            declared = artifact.get("tracked", []) + artifact.get("untracked", [])
            run(artifact["command"])
            inputs_after = snapshot(root, "worktree")
            for path in inputs_before.keys() | inputs_after.keys():
                if not matches(path, declared) and inputs_before.get(
                    path
                ) != inputs_after.get(path):
                    errors.append(f"{artifact['id']}: undeclared output change: {path}")
            local_after = protected_inputs(root, registry)
            for path in local_before.keys() | local_after.keys():
                if local_before.get(path) != local_after.get(path):
                    errors.append(
                        f"{artifact['id']}: protected local input changed: {path}"
                    )
            for pattern in artifact.get("untracked", []):
                if not output_files(root, [pattern]):
                    errors.append(
                        f"{artifact['id']}: generated local output missing: {pattern}"
                    )
        passes.append(captured_outputs())
    for artifact in artifacts:
        paths = {path for path in before if matches(path, artifact.get("tracked", []))}
        first, second = (p[artifact["id"]] for p in passes)
        if first != second:
            errors.append(f"{artifact['id']}: generator pipeline is not repeatable")
        for path in paths:
            if canonical(
                before[path],
                artifact.get("compare", "json" if path.endswith(".json") else "text"),
            ) != first.get(path):
                errors.append(
                    f"{path}: generated output differs from {revision}; review and commit regeneration"
                )
        actual = set(output_files(root, artifact.get("tracked", [])))
        if actual != paths:
            errors.append(
                f"{artifact['id']}: generated output inventory differs from {revision}"
            )
    return list(dict.fromkeys(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["preflight", "generated"])
    parser.add_argument(
        "--revision", default="HEAD", help="Git revision, index, or worktree"
    )
    parser.add_argument(
        "--base",
        help="Previous integration/release SHA for historical migration checks",
    )
    parser.add_argument(
        "--upstream",
        help="Merged upstream SHA; rejects fork records in upstream .ai paths",
    )
    parser.add_argument(
        "--group", action="append", help="Artifact group; defaults to source"
    )
    args = parser.parse_args()
    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
    try:
        errors = (
            preflight(root, args.revision, args.base, args.upstream)
            if args.command == "preflight"
            else generated(root, args.revision, args.group)
        )
        for error in errors:
            print(f"FAIL {error}", file=sys.stderr)
        if errors:
            return 1
        print(f"PASS fork {args.command} ({args.revision})")
        return 0
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        # Subprocess stdout is already visible; never echo arbitrary file data.
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(
            f"FAIL fork {args.command}: {reason}; required verification did not complete",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
