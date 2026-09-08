# Private database clients

- [x] Add optional PostgreSQL access over a private GCP address with verified TLS and narrowly scoped firewall rules.
- [x] Preserve database credentials, certificates, and client isolation across Carbon deployments.
- [x] Configure the separate application's runtime and migration job to use its own schema and credentials.
- [x] Verify schema permissions, PostgreSQL compatibility, and the deployment commands.
- [ ] Merge the Carbon feature into the deployment branch, integrate upstream, and deploy both applications.
- [ ] Verify the live applications and retire the replaced database service.

The other application's existing records may be discarded. Carbon's data and authentication behavior must remain intact. The application deployments remain independent; database service maintenance can interrupt both. Private deployment inputs and verification receipts stay outside tracked source.
