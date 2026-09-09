#!/usr/bin/env python3
"""Opt-in actual Codex protocol/sandbox smoke test; no live sync or publication."""

import json
from pathlib import Path
import subprocess
import tempfile

import sync_agent


def main():
    with tempfile.TemporaryDirectory(prefix="carbon-sync-codex-smoke-") as temporary:
        parent = Path(temporary).resolve()
        root = parent / "original"
        root.mkdir()

        def git(*args):
            return subprocess.run(
                ["git", "-C", str(root), *args],
                check=True,
                text=True,
                capture_output=True,
                env=sync_agent.clean_environment(),
            ).stdout.strip()

        git("init", "-b", "saturn/main")
        git("config", "user.name", "Synthetic Test")
        git("config", "user.email", "operator@example.com")
        git("config", "commit.gpgsign", "false")
        (root / "README.md").write_text("Synthetic sandbox fixture.\n")
        git("add", "README.md")
        git("commit", "-m", "Synthetic fixture")
        head = git("rev-parse", "HEAD")
        candidate = parent / "candidate"
        git("worktree", "add", "-b", "sync/synthetic", str(candidate))
        ctl = sync_agent.Controller(root, agent_timeout=180)
        ctl.state = {
            "base": head,
            "upstream": head,
            "head": head,
            "branch": "sync/synthetic",
            "candidate": str(candidate),
            "feedback": "Synthetic smoke test",
            "turns": 0,
        }
        prompt_dir = parent / "trusted"
        prompt_dir.mkdir()
        probe = prompt_dir / "probe.py"
        probe.write_text(
            "import json, subprocess\nfrom pathlib import Path\n"
            "Path('result.txt').write_text('synthetic integration ready\\n')\n"
            "run = subprocess.run(['git', 'add', '--', 'result.txt'], capture_output=True, text=True)\n"
            "Path('probe-receipt.json').write_text(json.dumps({'exit': run.returncode, 'error': run.stderr}))\n"
        )
        (prompt_dir / "sync-agent-prompt.md").write_text(
            "Synthetic integration worker smoke test. Execute python3 "
            + str(probe)
            + " exactly once. This trusted probe writes synthetic source and tests a "
            "Git staging denial. Do not edit the probe or create/change outputs "
            "yourself. Return action stage, paths [result.txt], summary of outcome. "
            "Do nothing else."
        )
        ctl.tools = prompt_dir
        before = sync_agent.fingerprint(candidate)
        result = ctl.codex()
        receipt = json.loads((candidate / "probe-receipt.json").read_text())
        if (
            result["action"] != "stage"
            or result["paths"] != ["result.txt"]
            or (candidate / "result.txt").read_text() != "synthetic integration ready\n"
            or receipt["exit"] == 0
            or "index.lock" not in receipt["error"]
            or not any(
                message in receipt["error"]
                for message in (
                    "Operation not permitted",
                    "Permission denied",
                    "Read-only file system",
                )
            )
            or before != sync_agent.fingerprint(candidate)
        ):
            raise ValueError("Actual Codex protocol/sandbox smoke failed")
        print(
            "PASS real Codex: structured action, source edit, denied shared Git write."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
