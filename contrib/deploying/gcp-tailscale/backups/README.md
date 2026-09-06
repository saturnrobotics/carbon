# Managed cold backups

The optional backup worker runs daily in GCP at **05:00 UTC**, independently of
the laptop, application VM and application deployment frequency. It retains
**90 days of daily recovery points** and the **first recovery point of each month
for 366 days**. The first run also establishes the initial monthly point. History
accumulates from installation; it cannot recover dates before backups existed.

The existing native 14-day Standard snapshot schedule remains enabled as an
additional, faster recovery path. Manual pre-deployment snapshots keep their
existing retention; this worker never deletes them.

## Coverage and cost

- An incremental **Archive disk snapshot** covers the complete retained data disk:
  all PostgreSQL databases/schemas, Supabase uploads, background-job state,
  runtime configuration, credentials and matching source releases.
- External versioned GCS attachment buckets are copied by exact object generation
  into a separate private **Archive bucket**. An unchanged generation is stored
  once. Small recovery manifests and concurrency leases use Standard storage.
- Each manifest maps source names/generations to verified backup checksums. Copies
  remain while any retained recovery point references them, and for at least 366
  days after creation to avoid Archive early-deletion charges.

The snapshot is crash-consistent. PostgreSQL replays WAL on recovery; PGDATA, WAL
and all tablespaces must remain on the same disk with `fsync` and
`full_page_writes` enabled. External-file coverage assumes immutable object keys,
file creation before the database reference, and removal of the database reference
before file deletion. Source bucket versioning preserves generations deleted
during capture. The worker includes those generations in the manifest; it never
writes to or deletes from a source bucket.

Native snapshot schedules only support Standard snapshots, so a small Cloud Run
job and Cloud Scheduler provide Archive scheduling and retention. Archive
snapshots are billed for compressed incremental data, not the provisioned disk
capacity. Database/index/WAL churn and cached build images also contribute.
Archive restores have retrieval charges and are slower; this is a daily recovery
plan, with up to approximately 24 hours of data loss, not point-in-time WAL
archiving. See [snapshot pricing](https://cloud.google.com/compute/disks-image-pricing)
and [Cloud Storage pricing](https://cloud.google.com/storage/pricing).

Backups survive loss of the source VM/disk or attachment bucket. They reside in
the same GCP project as the deployment; deleting that project or compromising its
administrators remains outside this protection. No irreversible retention lock is
applied. Application service accounts receive no access to the backup bucket, and
the application VM still has no service account.

## One-time setup

Use the normal private deployment configuration and authenticated laptop `gcloud`.
Copy `backups/config.example.json` to `.local/backups.json` beside `config.json`,
and restrict it to `chmod 600`. In that ignored file:

1. Set `location` to a GCP region for backup storage and the worker. A second
   region protects against a source-region outage, with possible transfer fees.
2. List any external attachment buckets in `source_buckets`. Use an empty list
   only if all durable uploads are on the retained disk. Enable versioning on
   each listed source bucket before proceeding.
3. Keep `daily_days: 90` and `monthly_days: 366`.
4. Set `alert_email` to the address authorized to receive backup alerts, or leave
   it empty for GCP incidents without email delivery.

From the repository root:

```bash
python3 contrib/deploying/gcp-tailscale/backups/setup.py
python3 contrib/deploying/gcp-tailscale/backups/setup.py --apply --run-now
```

The first command validates locally. The second provisions scoped service
accounts, private storage, an image built in GCP, the schedule and monitoring,
then waits for a complete backup. The worker has no third-party Python packages
and obtains short-lived credentials from Cloud Run.

Once `.local/backups.json` exists, **`make deploy` also maintains this setup**.
Only changes to the backup image inputs rebuild that image. Application updates
do not recreate backup history, rotate credentials or require changing Kanban.
Deleting the local file does not disable an already installed cloud schedule.

Private receipts, exact resource names and provisioning logs are written beside
the configuration. Never commit those files or backup manifests. They contain
deployment information and may identify private attachment objects.

## Monitoring and operation

The worker reports success only after a ready snapshot, completed file copies,
verified manifest and safe retention cleanup. Failed runs leave earlier recovery
points intact. Same-day retries reuse the day's snapshot and immutable copies.
A generation-conditional lease prevents concurrent executions from pruning each
other's work. A killed worker's lease expires after two hours.
Expired incomplete snapshots and abandoned manifests are cleaned up after a new
complete recovery point succeeds. Backups from a previous incarnation of the
source disk are retained conservatively; review their history manually after a
disk replacement before removing any retired recovery points.

Cloud Monitoring creates incidents for a failed execution or **30 hours without
a successful heartbeat**. Check that the first manual execution succeeds; a
scheduled trigger being enabled is not proof of a completed backup. The native
14-day schedule is a separate fallback, not part of the cold job's success signal.

Use the Cloud Run job's **Execute** button for an immediate retry, or the Cloud
Scheduler job's **Force run** button to test the scheduled invocation. Pause the
Scheduler job to stop automated runs; a subsequent `make deploy` deliberately
re-enables the configured schedule. Existing backups remain available.

## Test recovery without affecting production

Select a ready cold snapshot with a completed manifest from the private receipt
and GCP console. Run:

```bash
python3 contrib/deploying/gcp-tailscale/backups/verify_restore.py --snapshot SNAPSHOT_NAME
python3 contrib/deploying/gcp-tailscale/backups/verify_restore.py --snapshot SNAPSHOT_NAME --apply
```

The verifier creates a temporary snapshot copy and fresh VM, starts only the
snapshot's PostgreSQL image with networking and scheduled SQL jobs disabled,
verifies WAL recovery and required schemas, reads every database through
`pg_dump`, and hashes the restored Supabase storage files. It never starts copied
applications, Docker's copied daemon state or the copied Tailscale identity.
It removes its temporary VM/disk and leaves a private verification receipt.

Run this after backup setup, after major database/storage changes, and periodically.
Also test external-file recovery: fetch a manifest, copy a referenced Archive
object to an isolated location and compare its size/checksum with the manifest.
An empty attachment bucket has no application file to restore.

## Actual disaster recovery

1. Pick a completed recovery point. Keep the original disk and backups intact.
   Record the snapshot and matching manifest in a private incident log.
2. Stop the production VM and any separate clients that can write to its database.
   Restore the **whole disk** to a new retained disk; match the original size or
   larger. Do not restore just the database volume or rerun old migrations.
3. Restore external attachments into a separate recovery bucket using the
   manifest's original object names and verified generation-specific backup
   copies. Restore the versions referenced by the recovered database. The
   manifest can include extra versions that were live during capture; do not
   blindly overwrite a file with an arbitrary generation.
4. Verify PostgreSQL and file recovery in isolation. The snapshot also restores
   database roles, keys, migration history, runtime descriptors and source
   releases. Keep credentials private and use the matching source revision.
5. Attach the recovered disk as `carbon-data` to the production VM. Configure
   separate application clients to use the recovered attachment bucket if needed.
   Never run old and recovered Tailscale identities concurrently.
6. Start services and verify private login, ERP/MES/API, background processing,
   Kanban and representative attachments before resuming writes. Reattach the
   native disk schedule and rerun backup setup for a replacement source disk.

The public repository deliberately contains no operator-specific project IDs,
domains, credentials or recovery manifests.
