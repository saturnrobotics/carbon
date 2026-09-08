# Automatic release preparation

User authorization: automate manifest preparation and integrate it with deployment.

## Progress
- [x] Generate complete ERP/MES desired inputs from source, private configuration, observed secret versions, and resolved base images.
- [x] Wire a read-only cloud preview and automatic preparation before deployment mutations; persist private artifacts atomically.
- [x] Pass resolved base references to actual host builds; automatically choose coordinated maintenance for unknown legacy state.
- [x] Verify that ordinary make deploy initializes the baseline, snapshots before maintenance, and keeps routine app updates scoped without requiring extra commands.
- [x] Verify regression suites, privacy boundaries, failure handling, and document operator commands.

## Implementation

Create `contrib/deploying/gcp-tailscale/prepare_release.py` and `test_prepare_release.py`. Observe the existing VM through read-only commands, distinguishing absence from network/permission failures. Use existing Turbo source closure calculation. Include both managed services and reject unsupported prior inventory. Hash private inputs without persisting credentials. Resolve actual base digests and carry pinned build arguments to the host. Automatically choose coordinated maintenance when no baseline exists or shared infrastructure inputs changed; never infer existing containers match desired source. The normal operator interface is only `make deploy`; previews and force-maintenance commands are optional diagnostics/overrides.

Modify `deploy.py`, root `Makefile`, and deployment `README.md` to provide `make deploy-plan`, regenerate on every apply unless an explicit custom input is supplied, and preserve clean deployment-branch checks. Generate local files with atomic replacement and mode 600. Do not push, deploy, or modify remote state while implementing or previewing.

Modify `Dockerfile` and `host-deploy.sh` for pinned base arguments and persistence of maintenance fingerprint metadata. Preserve existing unrelated changes.

Verification: run `python3 -m unittest test_prepare_release test_deploy test_release_plan test_service_rollout test_base_images` from the deployment directory; expect all tests pass. Run `bash -n host-deploy.sh` and scoped `git diff --check`. Test real read-only preparation where environment prerequisites permit; distinguish previews from production deployment proof.
