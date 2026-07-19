# Domain security automation plan

- [x] Normalize the documented ERP/MES hostnames and mark environment snippets as partial.
- [x] Add deterministic Saturn domain validation and deployment preflight checks.
- [x] Change deployed Carbon cookies to host-only secure cookies and add focused tests.
- [x] Replace the superseded deSEC integration with a pinned Google Cloud DNS Caddy build and ADC-based Swarm overlay.
- [x] Replace GoDaddy/deSEC instructions with Cloudflare parent-DNS and Google Cloud DNS child-zone instructions.
- [x] Remove the x64-only Saturn runner constraint and verify the stack's Linux ARM64 compatibility.
- [x] Add operator Make targets and update deployment documentation.
- [x] Run scoped shell, configuration, custom-Caddy, and architecture checks.
