# Private artifact cleanup and prevention

The privacy audit identified twenty fork-origin artifact paths for local history
removal: thirteen compiled Python caches containing private machine paths, a
generated localhost TLS key and certificate, two Terraform provider binaries with
two accompanying license copies, and generated test-run state. The binaries
account for about 245 MB. None of these paths occurs in public upstream ancestry
or either branch advertised by the fork's GitHub remote at audit time.

Secret-pattern scanning and comparison with known local deployment identifiers
found no actual deployment identifier matches in fork-authored content. Separate
review identified inherited hardcoded service credentials and deployment values
in upstream utility scripts and thumbnail generation. Their current-code copies
are replaced by explicit environment configuration. Erasing inherited public
history is a separate ancestry decision from purging fork-origin private files.

Terraform state, plans, provider installation directories, private variable
inputs, Docker authentication/cache/image/volume artifacts, and runtime environment
files are now ignored and rejected if force-added. Reviewed environment examples,
Terraform source and lockfiles, Dockerfiles, and Compose source remain visible.
The two example applications use empty `.env.example` templates; populated local
environment files stay local. Complete private PEM keys are detected in ordinary
source and escaped JSON without printing their contents.

Required CI exercises the actual commit hook and all three supported Docker ignore
contexts using synthetic inputs. These tests check both exclusion of private
artifacts and retention of source, and reject unsafe rule re-inclusion. Current
utility scripts also have actual-callsite configuration tests, and thumbnail tests
exercise its production request handler without contacting an external browser.

Root utility scripts require explicit local configuration; their error messages
name missing variables without values. Put report output below ignored
`.fork/local/` or outside the checkout. Thumbnail generation requires
`BROWSERLESS_WS_URL`; the existing managed and development configurations already
provide this setting. No unknown credential was tested against a remote service.

Ignore rules do not alter existing Git objects, Git archives, or remote copies.
Local rewrite verification must compare every rewritten tree and parent mapping,
rescan retained refs, account for reflogs and linked-worktree indexes, and verify
object removal. Exact local evidence and rewrite mappings remain private. This
audit does not claim that pattern scans recognize every possible private fact.
