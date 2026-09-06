# Cold backups for the private deployment

- [x] Audit durable database/file locations and existing cloud backups.
- [x] Confirm retention: 90 daily recovery points and monthly points for one year.
- [x] Add a separate managed daily backup job using Archive disk snapshots and generation-specific Archive copies of external attachments.
- [x] Keep deployment settings, inventories, receipts and recovery details private; integrate idempotent provisioning with laptop deployment.
- [x] Configure scoped service accounts, cold storage, scheduling and failure/staleness monitoring.
- [x] Test retention, interrupted retries, versioned attachment coverage and recovery from an actual backup in isolation.
- [x] Verify live cloud configuration and service health and document recovery.

Merge the verified feature and deploy from the integration branch after the
recovery exercise passes; keep the deployed revision and receipts private.

The existing native 14-day disk schedule remains a second recovery path. The cold
job runs independently of the VM and application release cadence. A completed
recovery point includes the whole persistent disk and an external-file manifest;
expiration runs only after a new recovery point succeeds. No production database
schema or authentication change is needed. Source attachments must use versioning
so deletes concurrent with the disk capture can still be copied by generation.
