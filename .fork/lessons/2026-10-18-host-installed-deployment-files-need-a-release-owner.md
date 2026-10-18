## Host-installed deployment files need a release owner

**Context:** Adding a host timer and helper scripts under `contrib/deploying/gcp-tailscale/` that `bootstrap.sh` or `host-deploy.sh` install on the VM.

**Problem:** The release planner treats `contrib/` as a known area with no owning service. A release that changes only such a file is a no-op: `make deploy` returns before bootstrap or finalize runs, so the change never reaches the host. The same applies to private config keys that no service renders.

**Rule:** List every host-installed file in `prepare_release.MAINTENANCE_PATHS`, as `certificates.sh` is. Leave host-only config keys unclassified so they select maintenance. Add a test that changing each one selects maintenance.

**Applies to:** Timers, helper scripts and host settings that the GCP deployment installs outside Compose.
