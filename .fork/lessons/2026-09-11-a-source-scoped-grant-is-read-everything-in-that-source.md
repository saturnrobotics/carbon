# A source-scoped grant is "read everything in that source"

Context: knowledge Drive connector (plan Task 19). A fixture gave a reader a
source-scoped `origin='source'` grant so the settings page could list the
source, and the descendant-revocation test then kept passing when it should
have failed.

Problem: `knowledge.has_grant` treats a grant with `documentId IS NULL AND
entityId IS NULL` as matching every document of the source. A grant added to
make a source *visible* silently made every document in it *readable*, so a
per-file revocation could not be observed. The same is true of the reader
policy on `knowledge.source` and `knowledge."driveEnrollment"`: a reader sees a
non-upload source only through a source-scoped source grant, which is also a
read-all grant.

Rule: never write a source-scoped `origin='source'` grant from a connector.
Connector output is file-level only, and a source-scoped source grant is an
administrator statement ("this employee is a member of the whole shared drive")
recorded at enrollment. In tests, give the reader whose revocation you are
proving file-level grants only, and use a different reader for the
"source is listed" assertion.

Applies to: `packages/knowledge/migrations` policies that call `can_access` or
`has_grant` with a NULL document, `packages/knowledge/src/sources/drive.server.ts`,
any future connector that maps external membership onto `knowledge."grant"`.
