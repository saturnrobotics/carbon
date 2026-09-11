# Conformance coverage during upstream integration

The upstream baseline change selected `@carbon/checks` in application CI and
exposed eight existing fork findings. The rules themselves had not changed.
Application validation now always selects the checks package: an unchanged
checker must still examine changed application source. Its rules and baseline
are protected controller inputs; a repair worker cannot rewrite this gate.

Seven individually reviewed baseline keys account for those eight findings. The
baseline was not regenerated and the rules were not broadened:

- The immutable knowledge receipt migration uses the existing tenant-scoped
  permission helper in two policies, sharing one scanner key. Employee membership
  and purchasing permission are evaluated against the row's company; this records
  historical syntax without changing authentication or an applied migration.
- The server-only knowledge module has no UI directory or separate types file;
  its models, service and exports carry the contract. Missing services/barrels and
  missing structure in other modules remain errors.
- ISO week arithmetic buckets whole days. PNG validation rounds integer pixel and
  scanline byte counts, including sub-byte packing. These are not price/quantity
  rounding operations.
- The payment adapter checks USD cent representability, then serializes the
  accepted amount to the provider's two-decimal wire format. Neither operation
  changes the submitted principal.

Exact path/snippet regressions reject altered calculations, added monetary
rounding, the same legacy SQL in a new migration, and other missing module
structure. Baseline matching cannot validate surrounding control flow; behavioral
payment tests and review remain necessary. This change does not claim that
structural checks prove every application invariant.
