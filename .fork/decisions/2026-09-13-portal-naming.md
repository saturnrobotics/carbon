# Portal naming and migration boundary

The company knowledge platform is now **Portal**. Application/package paths,
ERP operations and capabilities, environment names, Terraform resources,
service/image names, deployment tooling, language catalogs and active plans use
the new name. The entry points are `make deploy-portal` and
`make deploy-portal-check`; deployment instructions are in
`contrib/deploying/portal/README.md`.

Historical SQL filenames and bytes remain immutable. A public forward migration
renames the three ERP platform tables and functions. A private forward migration
renames schemas, policy roles and stored identifiers while preserving object
identity, data, permissions and the migration ledger. Existing opaque IDs,
document object keys and historical Git references remain stable.

The migration runner supplies the old resolver only inside a historical
migration transaction and removes it before commit. Public generators therefore
produce the same contract with or without the private Portal schema installed.
Workforce revocation remains effective between the two migration streams.

Verification on an owned synthetic environment:

- All 1,017 Carbon migrations and 39 Portal migrations replayed from empty.
- Public database type copies and Swagger were byte-identical before and after
  private installation; their changes from the base were solely renaming and
  generated ordering. No dependency versions changed.
- The tracked legacy upgrade regression preserved rows, object IDs, ACLs, RLS,
  counters and historical checksums; verified continued revocation, repeat-run
  idempotence, and refusal of corrupted checksums.
- Portal's real database/Redis integration suite passed 457 tests; ERP workforce,
  read/outbox and procurement integration checks passed 169 tests. Query and
  scheduler integration passed seven tests; SQL boundary and budget checks passed
  42 tests; the security gate passed 19 attacks across 18 classes.
- Both browser fixture modes passed all 24 scenarios. The product label rendered
  as Portal; document extraction, publication, search, downloads, revocation and
  deletion were exercised through actual services.
- Portal deployment tests passed 118 cases and shared GCP deployment tests passed
  216 cases. Terraform validation, scoped typechecks, lint, locale compilation,
  four dataset checks and backup compatibility passed.

CI now exercises the legacy upgrade and regenerates the private database types
against its existing disposable fixture. The naming guard rejects old active
identifiers and checks pinned historical migration hashes.

No existing cloud resources or private deployment configuration were changed.
Cloud names are often resource identities: existing installations require the
documented snapshot, coordinated shutdown and cutover procedure. Terraform state
must not be blindly applied or moved to simulate renaming immutable cloud
resources. Preflight rejects legacy local configuration and legacy workloads in
the selected project; it cannot discover old workloads in another project that
share the same database.
