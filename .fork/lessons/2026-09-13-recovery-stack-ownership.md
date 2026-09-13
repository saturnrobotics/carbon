# Recovery must select the same database and storage owner

**Context:** Local knowledge stacks support independent Compose project names,
image tags and ports so verification can coexist with development.

**Problem:** The recovery command selected containers through configurable
Compose configuration but used a hardcoded default storage volume. Generic
disposable labels could not distinguish two otherwise identical stacks.

**Rule:** Carry the selected project through every recovery operation. Before
starting containers or copying data, verify the Compose project/service labels,
the actual mounted storage volume and that volume's ownership labels. Refuse a
foreign or bind mount. Start validated existing containers instead of recreating
them from configuration. Test with another valid stack present, and verify
cleanup separately from the recovery script's success output.

**Applies to:** `contrib/deploying/knowledge/verify-local-recovery.py` and other
disposable backup/restore or lifecycle tools with separately selected resources.

The browser suite also needs a final-state assertion: a later test's unconditional
cleanup erased the earlier manual workflow's retained fixture despite every
individual test passing. `local-stack.sh test` now checks uploaded originals and
tombstones after the entire suite when preservation is requested, and absence of
this run's captured intake/document rows in normal cleanup mode. Snapshot earlier
retained fixture IDs before the suite so those rows neither cause false cleanup
failures nor mask lost new fixtures. Seeded documents are not evidence that an
uploaded fixture survived.
