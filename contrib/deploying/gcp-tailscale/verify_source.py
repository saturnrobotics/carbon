#!/usr/bin/env python3
"""Require GitHub's successful fork workflow and final job for an exact commit."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


WORKFLOW = ".github/workflows/fork-check.yml"
INTEGRATION_BRANCH = "saturn/main"


def repository_slug(source):
    patterns = (
        r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)",
        r"git@github\.com:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)",
        r"ssh://git@github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)",
    )
    for pattern in patterns:
        match = re.fullmatch(pattern, source)
        if match:
            slug = match.group(1).removesuffix(".git")
            if all(part not in {"", ".", ".."} for part in slug.split("/")):
                return slug
    raise ValueError(
        "Fork verification requires a public GitHub repository URL without credentials"
    )


def github_json(path):
    """Use only the fixed GitHub API origin and never print provider bodies."""
    request = urllib.request.Request(
        "https://api.github.com" + path,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "carbon-fork-verification",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        exc.close()
        raise ValueError(
            f"Fork verification unavailable (GitHub HTTP {exc.code}); review the workflow and retry"
        ) from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise ValueError(
            "Fork verification unavailable: GitHub could not return valid workflow evidence"
        ) from None


def github_items(path, key, **query):
    items = []
    for page in range(1, 11):
        data = github_json(
            path
            + "?"
            + urllib.parse.urlencode({**query, "per_page": 100, "page": page})
        )
        if not isinstance(data, dict) or not isinstance(data.get(key), list):
            raise ValueError("Fork verification returned malformed workflow evidence")
        total = data.get("total_count")
        if not isinstance(total, int) or isinstance(total, bool) or total < 0:
            raise ValueError("Fork verification returned an invalid evidence count")
        batch = data[key]
        if not all(isinstance(item, dict) for item in batch):
            raise ValueError("Fork verification returned malformed evidence records")
        items.extend(batch)
        if len(items) == total:
            return items
        if not batch or len(items) > total:
            raise ValueError("Fork verification returned incomplete workflow evidence")
    raise ValueError(
        "Fork verification has too many matching records; review the workflow history"
    )


def require_verified(source, revision, *, branch=None):
    slug = repository_slug(source)

    def same_repository(value):
        return (
            isinstance(value, dict)
            and isinstance(value.get("full_name"), str)
            and value["full_name"].lower() == slug.lower()
        )

    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Fork verification requires a full commit SHA")
    query = {"head_sha": revision}
    if branch is not None:
        query["branch"] = branch
    runs = github_items(
        f"/repos/{slug}/actions/workflows/fork-check.yml/runs", "workflow_runs", **query
    )
    if not runs:
        raise ValueError(
            "Fork verification is missing for this revision; submit the candidate and wait for fork-verified"
        )
    for run in runs:
        if (
            run.get("head_sha") != revision
            or run.get("path") != WORKFLOW
            or (branch is not None and run.get("head_branch") != branch)
            or not same_repository(run.get("repository"))
            or not same_repository(run.get("head_repository"))
            or run.get("event") not in {"push", "pull_request", "workflow_dispatch"}
            or any(
                not isinstance(run.get(key), int)
                or isinstance(run[key], bool)
                or run[key] < 1
                for key in ("id", "run_number", "run_attempt")
            )
        ):
            raise ValueError(
                "Fork verification evidence does not match the repository, workflow, branch, and revision"
            )
        if run["event"] == "pull_request":
            requests = run.get("pull_requests", [])
            if not isinstance(requests, list) or not any(
                isinstance(request, dict)
                and isinstance(request.get("base"), dict)
                and isinstance(request.get("head"), dict)
                and request.get("base", {}).get("ref") == INTEGRATION_BRANCH
                and request.get("head", {}).get("sha") == revision
                for request in requests
            ):
                raise ValueError(
                    "Fork verification must target saturn/main at the same revision"
                )
    # A queued/failed newer run must not silently fall back to an older success.
    latest = max(runs, key=lambda run: (run["run_number"], run["run_attempt"]))
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        raise ValueError(
            "Fork verification is pending or unsuccessful; fork-verified must pass for this revision"
        )
    run_id, attempt = latest["id"], latest["run_attempt"]
    jobs = github_items(
        f"/repos/{slug}/actions/runs/{run_id}/attempts/{attempt}/jobs", "jobs"
    )
    gates = [job for job in jobs if job.get("name") == "fork-verified"]
    if (
        len(gates) != 1
        or gates[0].get("head_sha") != revision
        or gates[0].get("run_id") != run_id
        or gates[0].get("status") != "completed"
        or gates[0].get("conclusion") != "success"
    ):
        raise ValueError(
            "Fork verification final job is missing, skipped, unsuccessful, or belongs to another revision"
        )
    return {
        "revision": revision,
        "run_id": run_id,
        "run_attempt": attempt,
        "repository": slug,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--branch", required=True)
    args = parser.parse_args()
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(args.repo),
                "remote",
                "get-url",
                "--push",
                "--all",
                "origin",
            ],
            check=True,
            text=True,
            capture_output=True,
        )
        destinations = result.stdout.splitlines()
        if len(destinations) != 1:
            raise ValueError("Fork verification requires one origin push destination")
        receipt = require_verified(destinations[0], args.revision, branch=args.branch)
    except (ValueError, subprocess.CalledProcessError) as exc:
        message = (
            str(exc)
            if isinstance(exc, ValueError)
            else "Fork verification could not read the origin push destination"
        )
        print(message, file=sys.stderr)
        return 1
    print(
        f"Fork verification passed for {receipt['revision'][:12]} (run {receipt['run_id']}, attempt {receipt['run_attempt']})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
