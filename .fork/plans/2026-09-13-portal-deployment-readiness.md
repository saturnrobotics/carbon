# Portal initial deployment readiness

User-authorized scope: prepare the existing manual-v1 deployment using private
operator inputs, repair proven deployment defects, and verify readiness. No real
identifiers, provider responses, credentials or run logs belong in this plan.

- [x] Inspect deployment configuration and source/cloud prerequisites without
  exposing private values; preserve existing configuration before editing it.
- [x] Resolve the selected company and administrator through the existing source
  database. Selection is not identity enrollment or an access grant.
- [x] Add exactly scoped web-to-ingestion and parser-with-overrides permissions;
  prove missing permissions with regression tests before implementation.
- [x] Wire the managed Redis CA bundle to the query process, pin the secret
  version in revision identity, and prove TLS trust and rejection boundaries.
- [x] Run deployment Python tests, scoped runtime tests/typechecks, Terraform
  validation, formatting, privacy review and branch review.
- [ ] Resolve the background scheduler decision below before provisioning a
  production processing path or changing authentication contracts.
- [ ] Provision the reviewed foundation and verify the actual network, secrets,
  database observer, enrollment, library grants and request policy.
- [ ] Integrate through the normal PR/CI gate, then run deployment preflight and
  real authentication, upload, processing, retrieval and revocation checks.

## Background scheduler decision — proposed, not yet approved

The platform plan specifies an independent Inngest application. The current GCP
release only supplies a signing key; it has no configured event transport,
registered scheduler or authenticated callback transport. The ERP scheduler is
Docker-internal and is not already connected to Portal. Upload commits an outbox
row but tolerates wakeup failure, so HTTP success alone cannot prove processing.

Recommended bounded alternative for manual-v1:

1. `apps/portal-worker/src/index.ts`, `server.ts`, `functions.ts` and
   `invalidation.ts`: add a manual-v1 authenticated drain endpoint and extract the
   existing durable delivery/invalidation passes. Verify the exact scheduler
   identity and audience. Derive company/source principals on the server.
   Preserve Inngest support in other profiles; do not add unauthenticated ingress.
2. Process invalidations first, then one extraction per bounded request. Await
   completion. Reuse database leases, generation checks and acknowledgment after
   durable work. The existing 300-second lease cannot safely cover a parser that
   alone may take 300 seconds. Introduce a validated longer lease for this path
   and an end-to-end abort deadline shorter than both HTTP and lease limits.
3. `contrib/deploying/portal/identity.tf`, `release.py`, `deploy.py` and their
   examples/tests: provision a dedicated scheduler identity with access only to
   ingestion, configure an OIDC minute schedule, and explicitly select this
   execution mode. Keep scheduling paused until setup and authenticated dry
   execution pass. Remove the unused Inngest-key requirement only for this mode.
4. Prove unauthorized rejection, zero-work execution, real outbox processing,
   duplicate delivery, aborted extraction, lease expiry, lost acknowledgment and
   subsequent recovery. Preserve the existing Inngest test suite.

This changes the approved scheduler architecture and adds an authentication
endpoint. It requires an explicit decision before implementation. An alternative
is to retain Inngest and provision its production event/callback integration.

## Remaining operational verification

Terraform validation does not prove deployed IAM, Redis certificate SANs, IAP
admission, source listener connectivity or enrollment. The custom database
saturation metric must have a real emitter before monitoring can be called
complete. Keep infrastructure output, concrete Terraform plans and run evidence
in ignored private directories. Do not substitute invented resource IDs, secret
versions, metrics or access levels for verified outputs.
