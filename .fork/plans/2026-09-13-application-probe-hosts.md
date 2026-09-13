# Application host compatibility across deployment callers

- [x] Audit all deployment HTTP callers through ERP and MES root middleware.
- [x] Reproduce MES health and Inngest discovery host failures; verify canonical requests with strict TLS.
- [x] Add failing wire-level MES and registration regressions and shared configured-origin coverage.
- [x] Use canonical Host for both local probes and canonical private HTTPS for Inngest discovery, callback registration, and forced registration.
- [ ] Complete deployment tests, lint, independent review, and gated integration.
- [ ] Verify both applications and signed job registration after deployment.
