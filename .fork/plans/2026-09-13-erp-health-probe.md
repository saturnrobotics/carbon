# ERP health probe host compatibility

- [x] Trace production health requests through root middleware and the strict session-host resolver; verify configured Host succeeds using node:http.
- [x] Add a wire-level regression that executes the rendered probe against a local HTTP server, including dependency and HTTP failures.
- [x] Send the configured ERP Host over loopback with a bounded deadline, preserving strict session isolation.
- [ ] Run deployment regression tests and lint, inspect the public diff, and create a normally gated PR.
- [ ] Verify Docker health after the approved deployment.
