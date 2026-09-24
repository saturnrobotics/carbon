"""Select checks before dependency installation; uncertainty runs the full suite.

Pull requests use their merge-base diff. Pushes, schedules and manual runs always
verify everything. Keep this allowlist small: unrecognized inputs run all checks.
Application changes retain the complete Node suite so dependent packages cannot
be silently missed by an incomplete package dependency graph.
"""

import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess

CHECKS = (
    "node",
    "lingui",
    "catalog",
    "edge",
    "audit",
    "fork_node",
    "fork_python",
    "workflow",
)
NODE_CHECKS = {"node", "lingui", "catalog", "fork_node"}
PROSE_PREFIXES = (
    ".fork/plans/",
    ".fork/specs/",
    ".fork/decisions/",
    ".fork/lessons/",
    ".fork/research/",
    ".fork/playbooks/",
    "docs/fork/",
)
WORKFLOW_ONLY = {
    ".github/workflows/upstream-sync.yml",
    ".github/workflows/resolve-sync-conflicts.yml",
}


def classify_paths(paths):
    """Return the union of required checks; unknown files invalidate all skips."""
    selected = set()
    for path in paths:
        name = PurePosixPath(path).name
        if path.endswith(".md") and path.startswith(PROSE_PREFIXES):
            continue
        if path in WORKFLOW_ONLY:
            selected.add("workflow")
        elif path.startswith("contrib/deploying/") and path.endswith(".py"):
            selected.add("fork_python")
        elif (
            path.startswith(("apps/", "packages/"))
            and PurePosixPath(path).suffix
            in {".ts", ".tsx", ".js", ".jsx", ".css", ".po"}
            and not name.endswith((".config.ts", ".config.js", ".config.mjs"))
        ):
            selected.update(NODE_CHECKS)
            if path.startswith("packages/database/"):
                selected.add("edge")
        else:
            return dict.fromkeys(CHECKS, True)
    return {key: key in selected for key in CHECKS}


def git(repository, *args):
    return subprocess.run(
        ["git", *args], cwd=repository, check=True, capture_output=True, timeout=30
    ).stdout


def select_checks(event_name, event_path, repository="."):
    """Read GitHub's PR SHAs without fetching or accepting command-line revisions."""
    if event_name != "pull_request":
        return dict.fromkeys(CHECKS, True)
    try:
        event = json.loads(Path(event_path).read_text(encoding="utf-8"))
        pr = event["pull_request"]
        base, head = pr["base"]["sha"], pr["head"]["sha"]
        if not all(
            isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40,64}", sha)
            for sha in (base, head)
        ):
            raise ValueError("missing or invalid pull-request revision")
        if git(repository, "rev-parse", "--is-shallow-repository").strip() != b"false":
            raise ValueError("incomplete checkout history")
        ancestors = git(repository, "merge-base", "--all", base, head).splitlines()
        if len(ancestors) != 1:
            raise ValueError("ambiguous merge base")
        # --no-renames reports both sides of a rename, preserving tests selected
        # by the deleted origin. NUL separation supports spaces and newlines.
        diff = git(
            repository,
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            ancestors[0].decode("ascii"),
            head,
            "--",
        )
        paths = [
            path.decode("utf-8", errors="strict") for path in diff.split(b"\0") if path
        ]
        return classify_paths(paths)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print(
            "CI selection could not establish complete PR inputs; running all checks."
        )
        return dict.fromkeys(CHECKS, True)


def main():
    checks = select_checks(
        os.environ.get("GITHUB_EVENT_NAME"), os.environ.get("GITHUB_EVENT_PATH", "")
    )
    outputs = "".join(f"{key}={str(value).lower()}\n" for key, value in checks.items())
    print(outputs, end="")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(outputs)


if __name__ == "__main__":
    main()
