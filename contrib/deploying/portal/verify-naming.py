#!/usr/bin/env python3
"""Reject old active platform identifiers while preserving migration evidence.

The exact compatibility paths in naming-history.json are reviewed forward
migration code, legacy-input rejection and regression tests. They are not a
prefix exemption for future files. Generic upstream agent knowledge vocabulary
and archived fork records belong to separate systems/history.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
LEGACY = re.compile(
    r"KNOWLEDGE_[A-Z0-9_]+|@carbon/knowledge\b|"
    r"(?:apps|packages|contrib/deploying|apps/erp/app/modules)/knowledge(?:[-/]|\b)|"
    r"\bknowledge(?:_migrations|_metering|_read|_review|_ingest|_maintenance|_owner|_migration|_source|_actions)[A-Za-z0-9_]*|"
    r"\bknowledge\.(?:read|query|identity|intake|document|actor_id|company_id)\b|"
    r"\bknowledge(?:Source|Request|Identity|Receiver|Document|Command|Procurement)[A-Za-z0-9_]*|"
    r"\bknowledge-(?:web|query|ingest|worker|actions|parser|schema|retention|source|private|runtime)\b|"
    r"knowledge://"
)
HISTORICAL_NAME = re.compile(r"\b[0-9]{14}_knowledge[a-z0-9_-]*\b")
OWNED = ("apps/portal/", "apps/portal-", "apps/erp/app/modules/portal/", "packages/portal/", "contrib/deploying/portal/")
ARCHIVES = (".fork/", ".ai/")


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def source_files(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        capture_output=True, check=True,
    )
    return sorted({name for name in result.stdout.decode().split("\0") if name and (root / name).is_file()})


def check(root: Path, paths, history: dict) -> list[str]:
    failures = []
    pinned = history["files"]
    compatibility = set(history["compatibility"])
    historical_names = {Path(name).stem for name in pinned}
    for name, expected in pinned.items():
        path = root / name
        if not path.is_file() or digest(path.read_bytes()) != expected:
            failures.append(f"{name}: historical migration bytes changed or missing")
    for name in paths:
        if name in pinned or name in compatibility or name.startswith(ARCHIVES):
            continue
        path = root / name
        if LEGACY.search(name):
            failures.append(f"{name}: legacy platform path")
            continue
        try:
            content = path.read_text()
        except UnicodeError:
            continue
        content = HISTORICAL_NAME.sub(
            lambda match: "historical_migration" if match.group() in historical_names else match.group(), content
        )
        # Within the product's own executable trees, every spelling is a stale
        # identifier. Prose may still discuss the knowledge-base concept.
        owned_code = name.startswith(OWNED) and path.suffix != ".md"
        pattern = re.compile(r"(?<!ac)knowledge", re.IGNORECASE) if owned_code else LEGACY
        if pattern.search(content):
            failures.append(f"{name}: legacy active platform identifier")
    return failures


def main() -> int:
    history = json.loads((HERE / "naming-history.json").read_text())
    failures = check(ROOT, source_files(ROOT), history)
    for failure in failures:
        print(failure)
    if failures:
        return 1
    print("Portal naming and immutable migration history verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
