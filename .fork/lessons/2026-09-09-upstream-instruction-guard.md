# Distinguish upstream guidance from verification controls

Context: Routine upstream sync stopped before its first model turn when upstream
updated authored rule and skill Markdown.

Problem: A directory-wide control freeze treated ordinary upstream guidance as
mutable verification code. Rename detection also hid a protected source path when
the destination was outside the protected directories.

Rule: Permit upstream guidance only with exact pinned content and regular file
mode in the index and worktree, and only where the fork has no custom baseline
content. Check HEAD separately to reject concealed committed changes. Keep fork
policy and executable controls protected. Inspect renames as deletion plus addition
across committed, staged, and working snapshots. A CLI prerequisite check does not
prove that a real integration can progress through the controller.

Applies to: The local sync controller, its protocol, and real Git regression fixtures.
