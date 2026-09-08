"""Select verification from an explicit Git baseline and reject incomplete CI."""

import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import tempfile
import unittest


SUITES = ("source", "schema", "application", "invoice", "knowledge")
SHA = re.compile(r"[0-9a-f]{40}")
GLOBAL_INPUTS = {
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "turbo.json",
    ".dockerignore",
    "biome.jsonc",
    ".fork/ci.py",
    ".fork/verify.py",
    ".fork/generated-artifacts.json",
    ".fork/biome-check.json",
    ".github/workflows/fork-check.yml",
    ".github/workflows/fork-audit-schedule.yml",
    ".fork/tests/test_ci.py",
}
SCHEMA_INPUTS = {
    ".fork/schema.py",
    ".fork/tests/test_schema.py",
    "scripts/generate-db-types.ts",
    "scripts/generate-swagger-docs.ts",
    "packages/database/src/types.ts",
    "packages/database/supabase/functions/lib/types.ts",
    "packages/database/src/swagger-docs-schema.ts",
    "packages/jobs/manifests/schema.json",
}


def git(root, *args):
    result = subprocess.run(
        ["git", "-C", str(root), *args], check=False, capture_output=True, text=True
    )
    if result.returncode:
        raise ValueError(
            f"Git {args[0]} failed; required revision evidence is unavailable"
        )
    return result.stdout.strip()


def validate_revision(root, revision):
    if (
        not isinstance(revision, str)
        or not SHA.fullmatch(revision)
        or revision == "0" * 40
    ):
        raise ValueError("A complete nonzero commit SHA is required")
    if git(root, "rev-parse", "--verify", f"{revision}^{{commit}}") != revision:
        raise ValueError("The requested commit is unavailable")


def baseline(root, event_name, event, head, repository="", explicit=None):
    validate_revision(root, head)
    if git(root, "rev-parse", "HEAD") != head:
        raise ValueError("Checkout differs from the requested tested revision")
    if event_name == "pull_request":
        pull = event.get("pull_request", {})
        if pull.get("head", {}).get("repo", {}).get("full_name") != repository:
            raise ValueError("This workflow accepts only same-repository pull requests")
        if pull.get("head", {}).get("sha") != head:
            raise ValueError("Pull request head differs from the tested revision")
        selected = pull.get("base", {}).get("sha")
    elif event_name == "push":
        ref = event.get("ref", "")
        if ref == "refs/heads/saturn/main":
            selected = event.get("before")
        elif ref.startswith("refs/heads/sync/"):
            selected = git(
                root, "rev-parse", "--verify", "refs/remotes/origin/saturn/main"
            )
        else:
            raise ValueError("Unexpected push branch")
    elif event_name == "schedule":
        selected = git(root, "rev-parse", "--verify", "HEAD^1")
    elif event_name == "workflow_dispatch":
        selected = event.get("inputs", {}).get("base")
    else:
        raise ValueError("Unsupported workflow event")
    selected = explicit or selected
    validate_revision(root, selected)
    if selected == head:
        raise ValueError("The baseline must precede the candidate, not equal it")
    git(root, "merge-base", "--is-ancestor", selected, head)
    return selected


def classify(paths, full=False, registry=None):
    paths = set(paths)
    schema_patterns = [
        pattern
        for artifact in (registry or {}).get("artifacts", [])
        if artifact.get("group", "").startswith("schema")
        for pattern in artifact.get("inputs", []) + artifact.get("tracked", [])
    ]
    schema = (
        full
        or bool(paths & (GLOBAL_INPUTS | SCHEMA_INPUTS))
        or any(
            path.startswith(
                (
                    "packages/database/supabase/migrations/",
                    "patches/",
                    "scripts/lib/generate-db-types",
                    ".fork/schema",
                    ".fork/tests/test_schema",
                    "packages/dev/docker/",
                    "packages/jobs/src/backups/",
                    "packages/jobs/src/scripts/check-backups",
                )
            )
            for path in paths
        )
        or any(
            fnmatch.fnmatchcase(path, pattern)
            for path in paths
            for pattern in schema_patterns
        )
    )
    global_change = full or schema or bool(paths & GLOBAL_INPUTS)
    runtime = global_change or any(
        path.startswith(("apps/", "packages/", "scripts/", "contrib/deploying/"))
        and not path.endswith((".md", ".mdx"))
        for path in paths
    )
    return {
        "source": True,
        "schema": schema,
        "application": runtime,
        "invoice": runtime or ".github/workflows/saturn-invoice-check.yml" in paths,
        "knowledge": runtime or ".github/workflows/knowledge-check.yml" in paths,
    }


def event_scope(paths, event_name, registry=None):
    # An operator can supply any reviewed ancestor to a manual audit. It must
    # never narrow behavior checks by choosing an ancestor after a risky change.
    return classify(
        paths, full=event_name in {"workflow_dispatch", "schedule"}, registry=registry
    )


def check_results(needs, revision):
    prepare = needs.get("prepare", {})
    if prepare.get("result") != "success":
        raise ValueError("Candidate preparation did not succeed")
    outputs = prepare.get("outputs", {})
    if not SHA.fullmatch(revision) or outputs.get("revision") != revision:
        raise ValueError("Aggregate revision differs from verified candidate")
    try:
        scope = json.loads(outputs["scope"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Required scope evidence is missing") from error
    if (
        not isinstance(scope, dict)
        or set(scope) != set(SUITES)
        or any(not isinstance(value, bool) for value in scope.values())
        or scope["source"] is not True
    ):
        raise ValueError("Required scope evidence is invalid")
    for job, required in scope.items():
        result = needs.get(job, {}).get("result")
        allowed = {"success"} if required else {"success", "skipped"}
        if result not in allowed:
            raise ValueError(f"{job}: required CI result is missing or unsuccessful")


def changed(root, base, head="HEAD", *, include_deleted=True):
    return git(
        root,
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        *([] if include_deleted else ["--diff-filter=d"]),
        base,
        head,
    ).split("\0")


def prepare(root, args):
    event = json.loads(Path(args.event_file).read_text())
    head = git(root, "rev-parse", "HEAD")
    if args.revision and args.revision != head:
        raise ValueError("Checkout does not match the expected candidate")
    base = baseline(root, args.event_name, event, head, args.repository, args.base)
    validate_revision(root, args.upstream)
    git(root, "merge-base", "--is-ancestor", args.upstream, head)
    subprocess.run(
        [
            sys.executable,
            ".fork/verify.py",
            "preflight",
            "--revision",
            head,
            "--base",
            base,
            "--upstream",
            args.upstream,
        ],
        cwd=root,
        check=True,
    )
    registry = json.loads((root / ".fork/generated-artifacts.json").read_text())
    scope = event_scope(changed(root, base, head), args.event_name, registry=registry)
    result = {"revision": head, "base": base, "upstream": args.upstream, "scope": scope}
    if args.output:
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(result, indent=2) + "\n")
    if args.github_output:
        with Path(args.github_output).open("a") as output:
            for key, value in result.items():
                output.write(
                    f"{key}={json.dumps(value) if isinstance(value, dict) else value}\n"
                )
            for job, required in scope.items():
                output.write(f"{job}={str(required).lower()}\n")
    print(json.dumps(result))


def biome(root, paths, *, expanded=False, write=False):
    """Use inherited rules without registering a second project inside .fork."""
    with tempfile.TemporaryDirectory(prefix="carbon-biome-") as directory:
        config_args = []
        if expanded:
            config = json.loads((root / ".fork/biome-check.json").read_text())
            config["root"] = True
            config["extends"] = [str(root / "biome.jsonc")]
            # Paths are an explicit source allowlist collected from Git. The
            # temporary config has no Git checkout of its own to discover.
            # Lint/formatter rules are inherited unchanged from the repository.
            config["vcs"] = {"enabled": False, "useIgnoreFile": False}
            config_path = Path(directory) / "biome.json"
            config_path.write_text(json.dumps(config))
            config_args = [f"--config-path={config_path}"]
        return subprocess.run(
            [
                "corepack",
                "pnpm",
                "exec",
                "biome",
                "check",
                "--error-on-warnings",
                "--reporter=json",
                *config_args,
                *(["--write"] if write else []),
                "--",
                *paths,
            ],
            cwd=root,
            capture_output=True,
            text=True,
        )


def require_biome_result(result, paths):
    try:
        report = json.loads(result.stdout)
    except ValueError as error:
        raise ValueError(
            "Biome did not produce a check report; configuration or invocation failed"
        ) from error
    summary = report.get("summary", {})
    if result.returncode or summary.get("unchanged", 0) + summary.get(
        "changed", 0
    ) != len(paths):
        for diagnostic in report.get("diagnostics", []):
            location = diagnostic.get("location", {}).get("path", {})
            print(
                f"Lint: {location.get('file', '')}: {diagnostic.get('category', '')}",
                file=sys.stderr,
            )
        raise ValueError("Strict lint failed or an intended source file was ignored")
    print(f"PASS strict Biome: {len(paths)} source files")


def lint(root, base):
    """Check every supported changed source file, and reject ignored-file claims."""
    files = [
        path
        for path in changed(root, base, include_deleted=False)
        if (root / path).is_file()
    ]
    registry = json.loads((root / ".fork/generated-artifacts.json").read_text())
    generated = [
        pattern
        for artifact in registry["artifacts"]
        if artifact.get("kind") in {"generated-contract", "build-output"}
        for pattern in artifact.get("tracked", []) + artifact.get("untracked", [])
    ]
    scripts = []
    native = []
    python = []
    for path in files:
        if any(fnmatch.fnmatchcase(path, pattern) for pattern in generated):
            continue
        if path.endswith(".py"):
            python.append(path)
        elif Path(path).suffix in {
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mjs",
            ".cjs",
            ".json",
            ".jsonc",
        }:
            (
                native
                if path.startswith(("apps/", "packages/"))
                and "/test/" not in path
                and "/tests/" not in path
                else scripts
            ).append(path)
    for paths, expanded in ((native, False), (scripts, True)):
        if not paths:
            continue
        require_biome_result(biome(root, paths, expanded=expanded), paths)
    if python:
        subprocess.run(["ruff", "check", "--", *python], cwd=root, check=True)
    if not native and not scripts and not python:
        print(
            "No changed source files in Biome/Python coverage; source integrity still required"
        )


def application(root, base):
    paths = changed(root, base)
    packages = {"erp", "@carbon/jobs", "@carbon/database"}
    manifests = list((root / "apps").glob("*/package.json")) + list(
        (root / "packages").glob("*/package.json")
    )
    for manifest in manifests:
        relative = manifest.parent.relative_to(root).as_posix() + "/"
        if any(path.startswith(relative) for path in paths):
            packages.add(json.loads(manifest.read_text())["name"])
    filters = [f"--filter={package}" for package in sorted(packages)]
    # This existing inventory is also the exact list executed by the mandatory
    # invoice workflow against its disposable database. Never drop that suite
    # merely because the unit job has no infrastructure.
    invoice = runpy.run_path(
        str(root / "contrib/deploying/gcp-tailscale/check_invoice.py")
    )
    database_tests = invoice["JOBS_DATABASE_TESTS"]
    job_unit_command = [
        "corepack",
        "pnpm",
        "--filter",
        "@carbon/jobs",
        "exec",
        "vitest",
        "run",
    ]
    for test in database_tests:
        job_unit_command.extend(["--exclude", test])
    for command in (
        ["corepack", "pnpm", "--filter", "@carbon/config", "build"],
        ["corepack", "pnpm", "--filter", "erp", "typegen"],
        [
            "corepack",
            "pnpm",
            "exec",
            "turbo",
            "run",
            "test",
            "--concurrency=1",
            *filters,
            "--filter=!@carbon/jobs",
        ],
        job_unit_command,
        [
            "corepack",
            "pnpm",
            "exec",
            "turbo",
            "run",
            "typecheck",
            "--concurrency=1",
            *filters,
        ],
        [
            "corepack",
            "pnpm",
            "exec",
            "turbo",
            "run",
            "build",
            "--concurrency=1",
            *filters,
        ],
    ):
        subprocess.run(command, cwd=root, check=True)


def run_unittests(root, directory, pattern="test_*.py"):
    suite = unittest.defaultTestLoader.discover(str(root / directory), pattern=pattern)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful() or result.skipped or result.testsRun == 0:
        raise ValueError(
            "Mandatory unittest suite failed, skipped tests, or collected no tests"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prep = subparsers.add_parser("prepare")
    prep.add_argument(
        "--event-file",
        default=os.environ.get("GITHUB_EVENT_PATH"),
        required="GITHUB_EVENT_PATH" not in os.environ,
    )
    prep.add_argument(
        "--event-name",
        default=os.environ.get("GITHUB_EVENT_NAME"),
        required="GITHUB_EVENT_NAME" not in os.environ,
    )
    prep.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    prep.add_argument("--revision")
    prep.add_argument("--base")
    prep.add_argument("--upstream", required=True)
    prep.add_argument("--output")
    prep.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT"))
    aggregate = subparsers.add_parser("aggregate")
    aggregate.add_argument("--needs-json", default=os.environ.get("FORK_NEEDS_JSON"))
    aggregate.add_argument("--revision", required=True)
    for name in ("lint", "application"):
        child = subparsers.add_parser(name)
        child.add_argument("--base", required=True)
    unit = subparsers.add_parser("unittest")
    unit.add_argument("--directory", required=True)
    unit.add_argument("--pattern", default="test_*.py")
    lint_files = subparsers.add_parser("biome")
    lint_files.add_argument("--write", action="store_true")
    lint_files.add_argument("paths", nargs="+")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    try:
        if args.command == "prepare":
            prepare(root, args)
        elif args.command == "aggregate":
            check_results(json.loads(args.needs_json or "{}"), args.revision)
            print(f"PASS fork-verified ({args.revision})")
        elif args.command == "lint":
            lint(root, args.base)
        elif args.command == "unittest":
            run_unittests(root, args.directory, args.pattern)
        elif args.command == "biome":
            require_biome_result(
                biome(root, args.paths, expanded=True, write=args.write), args.paths
            )
        else:
            application(root, args.base)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f"FAIL fork CI: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
