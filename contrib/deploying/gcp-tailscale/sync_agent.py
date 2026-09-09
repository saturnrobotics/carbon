#!/usr/bin/env python3
"""Run a bounded, resumable Codex upstream integration with verified promotion.

This is an operator tool for trusted source, not a hostile-code sandbox. Codex
edits candidate files; this controller alone stages, commits, publishes and promotes.
"""

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import sys
import time

import verify_source

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STABLE = "saturn/main"
ACTIONS = {"stage", "schema", "ready", "blocked"}
# These inputs confer verification/publication authority. Integrate their changes
# separately under review, never let this repair loop revise its own acceptance test.
AUTHORITY = (
    ".github/",
    ".husky/",
    ".fork/hooks/",
    "contrib/deploying/",
    "scripts/",
    ".fork/",
    ".fork/tests/",
    ".fork/agent-policy.md",
    ".claude/",
    ".codex/",
    "AGENTS.md",
    ".gitignore",
    ".gitattributes",
    ".npmrc",
    ".pnpmfile.cjs",
)
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "action": {"type": "string", "enum": sorted(ACTIONS)},
        "paths": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["action", "paths", "summary"],
}


def validate_action(value):
    if (
        not isinstance(value, dict)
        or set(value) != set(SCHEMA["required"])
        or not isinstance(value["action"], str)
        or value["action"] not in ACTIONS
        or not isinstance(value["summary"], str)
        or not isinstance(value["paths"], list)
        or not all(isinstance(path, str) for path in value["paths"])
        or len(value["paths"]) != len(set(value["paths"]))
        or (value["action"] != "stage" and value["paths"])
    ):
        raise ValueError("Invalid structured agent response")
    return value


def safe_paths(root, paths):
    for name in paths:
        path = PurePosixPath(name)
        if (
            not name
            or path.is_absolute()
            or str(path) != name
            or any(part in {"..", ".git"} for part in path.parts)
            or any(ord(char) < 32 for char in name)
            or name.startswith(":")
            or name == ".fork/local"
            or name.startswith(".fork/local/")
            or not (root / name).resolve().is_relative_to(root.resolve())
        ):
            raise ValueError("Agent requested an unsafe repository path")
    return paths


def clean_environment():
    result = {
        key: os.environ[key]
        for key in (
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "LANG",
            "LC_ALL",
            "TERM",
            "TMPDIR",
        )
        if key in os.environ
    }
    result.update(
        {
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_EDITOR": "true",
            "PYTHONDONTWRITEBYTECODE": "1",
            "CARBON_EDITION": "community",
            "CARBON_PORTLESS": "0",
        }
    )
    return result


def git(root, *args, check=True):
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        env=clean_environment(),
        timeout=120,
        check=False,
    )
    if check and result.returncode:
        raise ValueError(f"Git {args[0]} failed; existing work is preserved")
    return result.stdout.decode("utf-8", errors="strict").strip()


def require_no_operation(root, *, allowed_merge=None):
    for operation in (
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ):
        location = Path(git(root, "rev-parse", "--git-path", operation))
        if not location.is_absolute():
            location = root / location
        if location.exists():
            if (
                operation == "MERGE_HEAD"
                and allowed_merge
                and location.read_text().strip() == allowed_merge
            ):
                continue
            raise ValueError(
                "Unrecorded Git operation in checkout; preserve and review it before continuing"
            )


def full_sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("State requires full Git revisions")
    return value


def changed_paths(root):
    output = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "ls-files",
            "-m",
            "-d",
            "-o",
            "--exclude-standard",
            "-z",
        ],
        capture_output=True,
        check=True,
        env=clean_environment(),
        timeout=120,
    ).stdout
    return sorted(set(os.fsdecode(p) for p in output.split(b"\0") if p))


def fingerprint(root):
    # Reading raw index includes its stat cache; use semantic index entries instead.
    return (
        git(root, "rev-parse", "refs/heads/saturn/main"),
        git(root, "ls-files", "--stage"),
        git(root, "symbolic-ref", "HEAD"),
        git(root, "rev-parse", "HEAD"),
        git(root, "rev-parse", "--verify", "MERGE_HEAD", check=False),
    )


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


@contextmanager
def exclusive_lock(path):
    with path.open("a+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another sync controller is running") from None
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


class Controller:
    def __init__(
        self, root, *, turns=12, agent_timeout=1800, ci_timeout=5400, model=None
    ):
        self.root = root.resolve()
        self.tools = HERE
        self.turn_limit = turns
        self.agent_timeout = agent_timeout
        self.ci_timeout = ci_timeout
        self.model = model
        common = Path(git(root, "rev-parse", "--git-common-dir"))
        if not common.is_absolute():
            common = root / common
        self.local = common.resolve() / "carbon-sync-agent"
        self.local.mkdir(mode=0o700, exist_ok=True)
        self.state_path = self.local / "state.json"
        self.state = None

    def save(self, **updates):
        self.state.update(updates)
        atomic_json(self.state_path, self.state)

    @property
    def candidate(self):
        return Path(self.state["candidate"])

    def run(
        self, args, *, cwd=None, label="command", timeout=1800, input=None, env=None
    ):
        """Private logs, a heartbeat, and whole-process-group cancellation."""
        log = self.local / f"{time.time_ns()}-{label}.log"
        print(f"Sync: {label} (log: {log})", flush=True)
        with log.open("wb") as output:
            process = subprocess.Popen(
                list(map(str, args)),
                cwd=cwd or self.candidate,
                env=env or clean_environment(),
                stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            started = time.monotonic()
            try:
                if input is not None:
                    process.stdin.write(input.encode())
                    process.stdin.close()
                while process.poll() is None:
                    if time.monotonic() - started > timeout:
                        raise TimeoutError(
                            f"{label} timed out; rerun make sync to resume"
                        )
                    time.sleep(1)
                    if int(time.monotonic() - started) % 30 == 0:
                        print(f"Sync: {label} still running", flush=True)
            except BaseException:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                raise
            finally:
                # Quiesce descendants left behind by a successful worker too.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        return process.returncode, log

    def origin(self):
        urls = git(
            self.root, "remote", "get-url", "--push", "--all", "origin"
        ).splitlines()
        if len(urls) != 1:
            raise ValueError("Sync requires exactly one origin push destination")
        verify_source.repository_slug(urls[0])
        return urls[0]

    def assert_original(self, *, promoted=False):
        require_no_operation(self.root)
        expected = self.state["head"] if promoted else self.state["base"]
        if (
            git(self.root, "branch", "--show-current") != STABLE
            or git(self.root, "rev-parse", "HEAD") != expected
            or git(self.root, "status", "--porcelain")
        ):
            raise ValueError(
                "Original checkout changed; preserve its work and reconcile before promotion"
            )

    def assert_candidate(self):
        require_no_operation(self.candidate, allowed_merge=self.state["upstream"])
        if (
            git(self.candidate, "rev-parse", "--show-toplevel") != str(self.candidate)
            or git(self.candidate, "branch", "--show-current") != self.state["branch"]
        ):
            raise ValueError("Candidate worktree identity changed")
        common = Path(git(self.candidate, "rev-parse", "--git-common-dir"))
        if not common.is_absolute():
            common = self.candidate / common
        if common.resolve() != self.local.parent:
            raise ValueError("Candidate belongs to a different Git repository")
        actual = git(self.candidate, "rev-parse", "HEAD")
        if actual != self.state["head"]:
            # Recover an interrupted controller commit only for the recorded tree.
            tree = self.state.get("commit_tree")
            if (
                not tree
                or git(self.candidate, "rev-parse", "HEAD^{tree}") != tree
                or git(self.candidate, "rev-parse", "HEAD^1") != self.state["head"]
            ):
                raise ValueError("Candidate revision changed outside the controller")
            self.save(head=actual, commit_tree=None)
        if self.origin() != self.state["origin"]:
            raise ValueError("Origin push destination changed during sync")

    def guard_authority(self):
        names = git(
            self.candidate, "diff", "--name-only", "-z", self.state["base"], "--"
        ).split("\0")
        names += changed_paths(self.candidate)
        records = (
            ".fork/plans/",
            ".fork/specs/",
            ".fork/lessons/",
            ".fork/decisions/",
            ".fork/research/",
            ".fork/playbooks/",
            ".fork/local/",
        )
        protected = sorted(
            {
                name
                for name in names
                if not name.startswith(records)
                and any(
                    name == prefix or (prefix.endswith("/") and name.startswith(prefix))
                    for prefix in AUTHORITY
                )
            }
        )
        if protected:
            raise ValueError(
                "Verification/control inputs changed; integrate these under separate review: "
                + ", ".join(protected[:12])
            )

    def prepare(self, adopt=None):
        if self.state_path.exists():
            self.state = json.loads(self.state_path.read_text())
            if self.state.get("version") != 1 or self.state.get("root") != str(
                self.root
            ):
                raise ValueError("Sync state belongs to another checkout or version")
            for field in ("base", "upstream", "head"):
                full_sha(self.state.get(field))
            if self.state.get("phase") == "complete":
                self.state_path.rename(self.local / f"complete-{time.time_ns()}.json")
                self.state = None
            else:
                if self.state.get("phase") == "preparing":
                    self.resume_preparing()
                self.assert_candidate()
                return True
        if git(self.root, "branch", "--show-current") != STABLE or git(
            self.root, "status", "--porcelain"
        ):
            raise ValueError(
                "Start sync from a clean saturn/main checkout; no automatic stash or reset"
            )
        require_no_operation(self.root)
        base = git(self.root, "rev-parse", "HEAD")
        # Preflight immutable source before any installation, merge or generator.
        result, _ = self.run(
            [
                sys.executable,
                self.tools.parents[2] / ".fork/verify.py",
                "preflight",
                "--revision",
                base,
            ],
            cwd=self.root,
            label="base-preflight",
        )
        if result:
            raise ValueError("Reviewed source preflight failed")
        origin = self.origin()
        git(
            self.root, "fetch", "upstream", "refs/heads/main:refs/remotes/upstream/main"
        )
        upstream = git(self.root, "rev-parse", "refs/remotes/upstream/main")
        if git(self.root, "merge-base", base, upstream) == upstream:
            print("Sync: upstream/main is already included.")
            return False
        branch = f"sync/upstream-{upstream[:12]}-{base[:12]}"
        candidate = (
            self.root.parent / f"{self.root.name}-worktrees" / branch.split("/")[1]
        )
        if adopt:
            candidate = adopt.resolve()
            if git(candidate, "branch", "--show-current") != branch:
                raise ValueError(
                    "Adoption requires the candidate for this exact baseline/upstream pair"
                )
            adopted_head = git(candidate, "rev-parse", "HEAD")
            if git(candidate, "merge-base", base, adopted_head) != base:
                raise ValueError(
                    "Adopted candidate does not contain the reviewed baseline"
                )
            merge_head = git(
                candidate, "rev-parse", "--verify", "MERGE_HEAD", check=False
            )
            if (
                merge_head != upstream
                and git(candidate, "merge-base", upstream, adopted_head) != upstream
            ):
                raise ValueError(
                    "Adopted candidate does not contain the pinned upstream revision"
                )
        elif (
            git(self.root, "show-ref", "--verify", f"refs/heads/{branch}", check=False)
            or candidate.exists()
        ):
            raise ValueError(
                "An unowned candidate exists; use --adopt with its worktree after checking it is idle"
            )
        self.state = {
            "version": 1,
            "root": str(self.root),
            "base": base,
            "upstream": upstream,
            "head": base,
            "branch": branch,
            "candidate": str(candidate),
            "origin": origin,
            "phase": "preparing",
            "turns": 0,
            "feedback": "Reconcile the upstream integration.",
        }
        self.save()
        if adopt:
            self.save(head=adopted_head, phase="repair")
        else:
            self.resume_preparing()
        return True

    def resume_preparing(self):
        """Recover only this controller's recorded worktree and pinned merge."""
        self.assert_original()
        candidate = self.candidate
        branch = self.state["branch"]
        base, upstream = self.state["base"], self.state["upstream"]
        if not candidate.exists():
            candidate.parent.mkdir(exist_ok=True)
            if git(
                self.root, "show-ref", "--verify", f"refs/heads/{branch}", check=False
            ):
                # worktree add can create its ref before populating the directory.
                if git(self.root, "rev-parse", branch) != base:
                    raise ValueError("Preparing candidate branch changed")
                git(self.root, "worktree", "add", str(candidate), branch)
            else:
                git(self.root, "worktree", "add", "-b", branch, str(candidate), base)
        self.assert_candidate()
        merging = git(candidate, "rev-parse", "--verify", "MERGE_HEAD", check=False)
        if merging:
            if merging != upstream:
                raise ValueError("Candidate merge does not match recorded upstream")
        elif git(candidate, "merge-base", upstream, self.state["head"]) != upstream:
            if git(candidate, "status", "--porcelain"):
                raise ValueError(
                    "Preparing worktree changed before merge; preserve and review its edits"
                )
            result, log = self.run(
                ["git", "merge", "--no-ff", "--no-commit", upstream], label="merge"
            )
            merging = git(candidate, "rev-parse", "--verify", "MERGE_HEAD", check=False)
            if result and merging != upstream:
                raise ValueError(
                    f"Merge failed before conflict resolution; inspect {log}"
                )
        self.save(phase="repair")

    def stage(self, paths):
        safe_paths(self.candidate, paths)
        if not paths or not set(paths).issubset(set(changed_paths(self.candidate))):
            raise ValueError("Stage requests must name only changed candidate files")
        # --literal-pathspecs plus -- makes model paths data, never Git options/globs.
        git(self.candidate, "--literal-pathspecs", "add", "--", *paths)

    def codex(self, *, review=False):
        before = fingerprint(self.candidate)
        self.guard_authority()
        self.save(turns=self.state["turns"] + 1)
        schema = self.local / "response-schema.json"
        atomic_json(schema, SCHEMA)
        response = self.local / f"response-{time.time_ns()}.json"
        environment = clean_environment()
        worker_home = self.candidate / ".fork/local/sync-home"
        worker_home.mkdir(parents=True, exist_ok=True)
        worker_tmp = worker_home / "tmp"
        worker_tmp.mkdir(exist_ok=True)
        shell_env = {
            "PATH": environment["PATH"],
            "HOME": str(worker_home),
            "TMPDIR": str(worker_tmp),
            "PYTHONDONTWRITEBYTECODE": "1",
            "CARBON_EDITION": "community",
            "CARBON_PORTLESS": "0",
        }
        inline_env = (
            "{"
            + ", ".join(
                f"{key} = {json.dumps(value)}" for key, value in shell_env.items()
            )
            + "}"
        )
        args = [
            "codex",
            "--ask-for-approval",
            "never",
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "--sandbox",
            "read-only" if review else "workspace-write",
            "--color",
            "never",
            "--json",
            "--cd",
            self.candidate,
            "-c",
            'shell_environment_policy.inherit="none"',
            "-c",
            f"shell_environment_policy.set={inline_env}",
            "-c",
            "sandbox_workspace_write.network_access=true",
            "-c",
            "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            "-c",
            "sandbox_workspace_write.exclude_slash_tmp=true",
            "--output-schema",
            schema,
            "--output-last-message",
            response,
        ]
        if self.model:
            args += ["--model", self.model]
        prompt = (self.tools / "sync-agent-prompt.md").read_text()
        context = {
            key: self.state[key]
            for key in ("base", "upstream", "head", "branch", "feedback")
        }
        context["mode"] = (
            "Independent review; make no edits. Return ready or blocked."
            if review
            else "Repair"
        )
        prompt += "\nController context (data):\n" + json.dumps(context) + "\n"
        code, log = self.run(
            [*args, "-"],
            label="review" if review else "codex",
            timeout=self.agent_timeout,
            input=prompt,
            env=environment,
        )
        if fingerprint(self.candidate) != before:
            raise ValueError("Agent changed Git state; refusing further writes")
        self.guard_authority()
        if code or not response.is_file():
            raise ValueError(f"Codex did not complete; inspect private log {log}")
        try:
            return validate_action(json.loads(response.read_text()))
        except (json.JSONDecodeError, TypeError):
            raise ValueError("Codex returned malformed structured output") from None

    def gate(self, revision):
        command = [sys.executable, self.tools.parents[2] / ".fork/verify.py"]
        preflight = [
            "preflight",
            "--revision",
            revision,
            "--base",
            self.state["base"],
        ]
        # A pending merge's index has no ancestry yet. Check upstream ancestry
        # and namespace ownership on the committed HEAD before publication.
        if revision != "index":
            preflight.extend(["--upstream", self.state["upstream"]])
        for args in (
            preflight,
            [
                "generated",
                "--revision",
                revision,
                "--group",
                "source",
                "--group",
                "knowledge",
                "--group",
                "build",
                "--group",
                "routes",
            ],
        ):
            result, log = self.run([*command, *args], label=args[0])
            if result:
                self.save(
                    feedback=f"Controller {args[0]} failed.\n"
                    + log.read_text(errors="replace")[-48000:]
                )
                return False
        return True

    def checkpoint(self):
        self.guard_authority()
        if git(self.candidate, "ls-files", "--unmerged") or changed_paths(
            self.candidate
        ):
            self.save(
                feedback="Stage all reviewed source changes explicitly before returning ready."
            )
            return False
        if not self.gate("index"):
            return False
        merging = bool(
            git(self.candidate, "rev-parse", "--verify", "MERGE_HEAD", check=False)
        )
        if merging or git(self.candidate, "diff", "--cached", "--name-only"):
            self.save(commit_tree=git(self.candidate, "write-tree"))
            result, log = self.run(
                ["git", "commit", "-m", "fix(sync): reconcile upstream integration"],
                label="commit",
            )
            if result:
                self.save(
                    feedback="Normal commit hook failed.\n"
                    + log.read_text(errors="replace")[-48000:]
                )
                return False
            self.save(head=git(self.candidate, "rev-parse", "HEAD"), commit_tree=None)
        return self.gate("HEAD")

    def wait_ci(self):
        started = time.monotonic()
        while True:
            self.assert_candidate()
            try:
                receipt = verify_source.require_verified(
                    self.state["origin"],
                    self.state["head"],
                    branch=self.state["branch"],
                )
                self.save(receipt=receipt)
                return True
            except verify_source.VerificationPending:
                if time.monotonic() - started >= self.ci_timeout:
                    raise ValueError(
                        "CI is still pending; rerun make sync to resume waiting"
                    ) from None
                print("Sync: waiting for exact-revision fork-verified", flush=True)
                time.sleep(30)
            except verify_source.VerificationFailed as error:
                slug = verify_source.repository_slug(self.state["origin"])
                code, log = self.run(
                    [
                        "gh",
                        "run",
                        "view",
                        str(error.run_id),
                        "--repo",
                        slug,
                        "--log-failed",
                    ],
                    label="ci-failure-log",
                )
                if code:
                    raise ValueError(
                        f"Cannot obtain CI failure diagnostics; inspect {log}"
                    ) from None
                self.save(
                    phase="repair",
                    feedback="Exact-revision CI failed. Fix the cause without weakening checks.\n"
                    + log.read_text(errors="replace")[-48000:],
                )
                return False

    def publish(self):
        self.assert_candidate()
        self.guard_authority()
        if git(self.candidate, "status", "--porcelain"):
            raise ValueError("Candidate must remain clean before publication")
        self.save(phase="publishing")
        code, log = self.run(
            [
                "git",
                "push",
                self.state["origin"],
                f"{self.state['head']}:refs/heads/{self.state['branch']}",
            ],
            label="publish",
        )
        if code:
            raise ValueError(f"Candidate publication failed; inspect {log}")
        self.save(phase="ci")

    def promote(self):
        self.assert_candidate()
        self.guard_authority()
        if git(self.candidate, "status", "--porcelain"):
            raise ValueError("Candidate changed after verification")
        verify_source.require_verified(
            self.state["origin"], self.state["head"], branch=self.state["branch"]
        )
        # Recover interruption immediately after the fast-forward without doing it again.
        if git(self.root, "rev-parse", "HEAD") == self.state["head"]:
            self.assert_original(promoted=True)
        else:
            self.assert_original()
            if (
                git(
                    self.candidate, "merge-base", self.state["base"], self.state["head"]
                )
                != self.state["base"]
                or git(
                    self.candidate,
                    "merge-base",
                    self.state["upstream"],
                    self.state["head"],
                )
                != self.state["upstream"]
            ):
                raise ValueError("Candidate lost required ancestry")
            self.save(phase="promoting")
            git(self.root, "merge", "--ff-only", self.state["head"])
        self.save(phase="complete")
        print(
            f"Sync complete: local {STABLE} at {self.state['head']}. Candidate CI passed. No deployment or stable-branch push."
        )

    def execute(self):
        while True:
            self.assert_candidate()
            self.guard_authority()
            if self.state["phase"] in {"publishing", "ci", "promoting"}:
                if self.state["phase"] == "publishing":
                    self.publish()
                if self.wait_ci():
                    self.promote()
                    return
            if self.state["turns"] >= self.turn_limit:
                raise ValueError(
                    "Repair turn budget exhausted; inspect progress, then increase --max-turns to continue"
                )
            action = self.codex()
            if action["action"] == "blocked":
                self.save(feedback=action["summary"])
                raise ValueError(
                    "Agent needs unavailable access or a decision; see --status and private logs"
                )
            if action["action"] == "stage":
                self.stage(action["paths"])
                self.save(
                    feedback="Requested paths staged. Continue repairs and verification."
                )
            elif action["action"] == "schema":
                python = self.candidate / ".fork/local/schema-tools/bin/python"
                interpreter = str(python) if python.is_file() else sys.executable
                result, log = self.run(
                    [
                        interpreter,
                        self.candidate / ".fork/schema.py",
                        "--base",
                        self.state["base"],
                        "--regenerate",
                    ],
                    label="schema",
                    timeout=5400,
                )
                self.save(
                    feedback=f"Owned schema repair exited {result}. Review/copy only its four proposed outputs.\n"
                    + log.read_text(errors="replace")[-48000:]
                )
            elif self.checkpoint():
                # Independent read-only reviewer; readiness alone never bypasses CI.
                if self.state["turns"] >= self.turn_limit:
                    raise ValueError(
                        "Reserve another turn for independent review; increase --max-turns"
                    )
                review = self.codex(review=True)
                if review["action"] != "ready":
                    self.save(
                        feedback="Independent review findings: " + review["summary"]
                    )
                    continue
                self.publish()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument(
        "--status",
        action="store_true",
        help="Show saved progress without running an agent",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check local CLI/login prerequisites without syncing",
    )
    parser.add_argument(
        "--adopt",
        type=Path,
        help="Explicitly adopt an idle candidate for the current SHA pair",
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        default=12,
        help="Total persisted agent turns, including review (default: 12)",
    )
    parser.add_argument(
        "--agent-timeout", type=int, default=1800, help="Seconds per agent turn"
    )
    parser.add_argument(
        "--ci-timeout",
        type=int,
        default=5400,
        help="Seconds to wait for CI per invocation",
    )
    parser.add_argument("--model", help="Optional locally available Codex model")
    args = parser.parse_args()
    try:
        if min(args.max_turns, args.agent_timeout, args.ci_timeout) < 1:
            raise ValueError("Budgets must be positive")
        root = Path(git(args.repo, "rev-parse", "--show-toplevel"))
        controller = Controller(
            root,
            turns=args.max_turns,
            agent_timeout=args.agent_timeout,
            ci_timeout=args.ci_timeout,
            model=args.model,
        )
        if args.status:
            if controller.state_path.exists():
                state = json.loads(controller.state_path.read_text())
                for key in ("phase", "base", "upstream", "head", "candidate", "turns"):
                    print(f"{key}: {state.get(key)}")
                print(f"Private details: {controller.state_path}")
            else:
                print("No saved sync run.")
            return 0
        for command in (
            ["codex", "exec", "--help"],
            ["codex", "login", "status"],
            ["gh", "--version"],
        ):
            result = subprocess.run(
                command, capture_output=True, env=clean_environment(), timeout=30
            )
            if result.returncode:
                raise ValueError(f"Prerequisite failed: {' '.join(command)}")
            if command[1:3] == ["exec", "--help"] and any(
                flag not in result.stdout
                for flag in (
                    b"--ignore-user-config",
                    b"--ignore-rules",
                    b"--output-schema",
                    b"--ephemeral",
                )
            ):
                raise ValueError(
                    "Installed Codex CLI lacks required automation flags; update Codex"
                )
        if args.check:
            controller.origin()
            print(
                "Sync prerequisites passed: Codex protocol flags, saved login, gh, public origin."
            )
            return 0
        with exclusive_lock(controller.local / "lock"):
            if controller.prepare(args.adopt):
                controller.execute()
        return 0
    except (ValueError, OSError, TimeoutError, subprocess.SubprocessError) as error:
        print(f"Sync stopped: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(
            "Sync interrupted; candidate preserved. Rerun make sync to resume.",
            file=sys.stderr,
        )
        return 130


if __name__ == "__main__":
    sys.exit(main())
