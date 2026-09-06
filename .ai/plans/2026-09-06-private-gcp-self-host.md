# Private GCP self-host deployment

## Progress

- [x] Inspect existing self-host runtime, authentication, licenses, and repository guidance.
- [x] Add public-fork privacy policy and a reviewable upstream-update workflow.
- [x] Add an opt-in Google Workspace authentication policy, enforced at token issuance.
- [x] Add a full-stack deployment derived from the existing self-host services.
- [x] Add GCP provisioning, private configuration, DNS certificates, persistent data, and update snapshots.
- [x] Verify deployment rendering, authentication rejection cases, script behavior, and changed app code.
- [x] Provide root `make deploy` / `make deploy-check` commands and a simple one-time operator walkthrough; verified command forwarding, paths with spaces, error propagation, and rejection of incomplete private configuration.
- [ ] Run the live deployment after the operator supplies project, DNS, and identity configuration.

## Implementation

1. `AGENTS.md`, `.gitignore`, `docs/public-fork.md`, and `scripts/sync-upstream.sh`: keep company configuration and data outside published source, preserve notices, and merge upstream on a review branch without publishing or deploying.
2. `contrib/deploying/gcp-tailscale/auth/`: deployment-only private-schema token hook using verified Google identity and hosted-domain claims. Gate email login UI/actions with the existing provider configuration. Exercise the hook in a disposable PostgreSQL cluster, never the developer database.
3. `contrib/deploying/gcp-tailscale/render.py` and `host-deploy.sh`: derive Compose services from the upstream Swarm example; correct required environment, jobs, migrations, seed, secrets, and private API routing. Publish only the Tailscale IPv4 HTTPS socket.
4. `contrib/deploying/gcp-tailscale/deploy.py`, `bootstrap.sh`, configuration examples, and README: use explicit GCP project arguments, private VM plus NAT and IAP SSH, a retained data disk, Cloudflare DNS-01 certificates, and a stopped-service snapshot before migrations. Upload committed source only; configuration travels separately over SSH. Preserve existing DNS services; create only three DNS-only A records.
5. Tests: offline provisioning/config validation and command orchestration, real Compose/Caddy config validation, authentication SQL regressions, shell parsing, changed-file lint/typechecks where available, and `git diff --check`.

The deployment target, domain, tailnet membership, credentials, and project identifiers belong only in ignored local configuration. The first deployment requires a billed project, a zone-scoped Cloudflare token, a Google OAuth Internal application, and a Tailscale enrollment key. A single VM has planned update downtime and is not highly available. Live checks remain pending until infrastructure configuration is supplied.

## Verification evidence

- 25 deployment/renderer tests, including real Docker Compose schema validation, passed.
- 19 token-hook tests passed against an isolated temporary PostgreSQL cluster.
- 12 edge-dispatcher/auth-helper tests passed, including forged privileged tokens and cross-user permission attempts.
- ERP, MES and environment-package scoped typechecks passed; changed app files passed Biome.
- ShellCheck passed all four deployment shell scripts; `git diff --check` passed.
- Real Caddy certificate/config validation, ops Docker image build plus Supabase CLI execution, and ERP Docker build target plus isolated production startup passed.
- Full runner image and MES Docker image builds were limited by local Docker disk exhaustion. Existing user images/caches/volumes were preserved.
- Live OAuth, tailnet/on-VPN access, off-VPN rejection, VM provisioning and restore rehearsal remain unverified. No cloud resources were provisioned during implementation.
