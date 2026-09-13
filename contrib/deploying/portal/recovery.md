# Portal retention and recovery

The portal system shares Carbon's PostgreSQL cluster. A database restore therefore has the same blast radius as the ERP database: it restores every schema in the selected backup. Rolling back a portal web, query, worker, parser, actions, or retention image changes only that Cloud Run revision. It does not roll back PostgreSQL or Cloud Storage.

The namespace rename requires a coordinated recovery snapshot, as described in
[the deployment guide](README.md#portal-naming-and-existing-installations).
A pre-rename image cannot be used with the renamed schema; preserve the old
state and storage until the Portal cutover and recovery checks pass.

The daily `portal-retention` job uses the `portal-maintenance` service account, a dedicated `PORTAL_MAINTENANCE_DATABASE_URL`, and delete-only access to the private object bucket. Its database login must be a member of `portal_maintenance` only. The ingestion and parser identities cannot delete objects. The job requests at most 100 database candidates, deletes the exact recorded Cloud Storage generations, and finalizes a record only after every listed deletion succeeds. Fixed database policy keeps raw intake and deleted-document derivatives for 30 days, audit rows for 365 days while redacting their metadata, and honors legal holds. Source and document tombstones remain canonical records.

Provision explicit read admission policy for every company and endpoint before traffic. There is no unbounded fallback:

```sql
INSERT INTO portal_metering."requestPolicy"
  ("companyId", endpoint, "userPerMinute", "companyPerMinute")
VALUES
  ('company-example', 'portal.query', 30, 300),
  ('company-example', 'portal.entity', 60, 600);
```

Use deployment-specific values and review them as operational configuration. Retention removes completed request-window counters after two minutes; policy rows remain until an administrator changes them.

For recovery, coordinate a full PostgreSQL restore with the Carbon recovery owner and restore the versioned object bucket to the same recovery point. Never restore over a developer, staging, or production database to perform a portal-only rollback. Restore into a new isolated environment, attach no user traffic, and verify migrations, canonical source records, workforce/source bindings, grants, document tombstones, versioned object references, and object generations before rebuilding indexes.

Run the destructive-proof harness only against the labelled synthetic container:

```bash
python3 contrib/deploying/portal/verify_recovery.py --synthetic --disposable
```

The harness makes a full logical backup, restores it into a new temporary database, adds a synthetic tombstoned document with a stale chunk, backs that state up again, and restores it into a second temporary database. It proves that an ACL-denied document remains denied, the tombstoned document never enters authorized reads or rebuild candidates, and active originals remain available through the bounded maintenance-only rebuild contract. It drops only its randomly named temporary databases and never modifies the source fixture.

After the isolated proof passes, use `portal.recovery_index_candidates(500)` through the maintenance login to feed `runRecoveryIndexBatch`. Each candidate includes an immutable object generation. Reparse and embed those originals with the deployed parser and embedding profile, then publish through the normal generation-checked index path. Keep the environment isolated until ACL and source-lag monitors are healthy.

Configure `monitoring_notification_channels` and the private connection-pool exporter's `database_connection_utilization_metric_type` in the untracked deployment inputs. Alerts consume only the bounded telemetry fields: service, stage, outcome, request ID, and numeric metrics. They do not require prompts, document content, audio, email addresses, tokens, or arbitrary metadata.
