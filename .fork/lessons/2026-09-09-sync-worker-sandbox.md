# Test shared Git protection in real worktrees

Context → A local integration worker used Codex workspace-write in a synthetic
worktree whose common Git directory was under the system temporary directory.

Problem → Default temporary-directory writes allowed staging through the shared
Git directory. Checking only the sandbox mode name missed that writable path.

Rule → Disable broad temporary-directory writes, provide a temporary directory
inside the candidate, and test an actual denied shared-Git write after CLI changes.
Keep controller Git writes outside the worker and independently compare Git state.
Model narration and a structured ready response are not verification evidence.
Workspace-write is not a guarantee of host-read or credential confidentiality.

Applies to → The local sync controller and future coding-agent orchestration.
