# Capture a listing before grep -q under pipefail

**Context:** The deployment tooling's host scripts run under `set -euo pipefail`
and checked for one line with `producer | grep -q`, such as the VM's private
address in `ip -4 -o address show scope global`.

**Problem:** `grep -q` exits at its first match. A producer still writing then
gets SIGPIPE, and pipefail reports the pipeline as failed (status 141) although
the line was found. The address check passed while the VM listed one interface,
then failed intermittently once Docker bridge networks were listed after it,
and refused a maintenance deployment. `grep … >/dev/null` is no fix: GNU grep
also stops at the first match when its output is `/dev/null`.

**Rule:** Under pipefail, never pipe a producer that can print more than one
line into a reader that may stop early (`grep -q`, `grep -l`, `grep -m`,
`head`). Capture the output first (`out=$(producer)`), decide what the
producer's own failure means, then match with `grep -q … <<<"$out"` or test
`[[ -n $out ]]`. Prove it with a stub producer that prints the match and then
more than a pipe buffers, so the old pipeline fails every time.

**Applies to:** shell under `contrib/deploying/gcp-tailscale/`, including scripts
it installs on the host, and any fork script that sets `pipefail`.
