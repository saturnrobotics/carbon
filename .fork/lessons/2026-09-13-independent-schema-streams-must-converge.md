# Independent schema streams must converge

**Context →** Renaming a separately deployed platform required replaying immutable
private migrations after the ERP's public migration renamed their resolver.

**Problem →** A compatibility RPC left behind by the public migration appeared
in freshly generated ERP types, but disappeared after the private migration.
Both databases were valid, yet generated-file checks produced different output.

**Rule →** Keep historical SQL bytes and ledger checksums immutable. Install a
compatibility RPC only inside the historical migration transaction that needs it,
restore the required grants on the canonical function, and remove the bridge
before committing. Verify that public type and API generators produce identical
artifacts before and after installing the private schema. Test the interval
between public and private migrations for continued permission revocation.

**Applies to →** Portal migrations, ERP-generated database/API artifacts, and any
future deployment with separately applied public and private schema histories.
