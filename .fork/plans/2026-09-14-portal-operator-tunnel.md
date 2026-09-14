# Manage the Portal operator connection

- [x] Reproduce missing tunnel ownership through the deployment command adapter.
- [x] Add an optional IAP tunnel configuration and a bounded, owned connection lifecycle for both Portal commands.
- [x] Preserve libpq credentials and TLS identity in a private temporary service file; clean up success, failure and interruption.
- [x] Verify real local process/listener behavior, focused regressions, and the full Portal Python suite; independently review.
- [x] Configure existing private deployment inputs and prove a bounded read-only connection against the managed platform.
- [x] Record exact validation: 178 deployment tests, lint and independent review pass; focused IAP/TLS catalog and ledger reads pass with verified listener/process/credential cleanup.
- [ ] Integrate through normal PR and CI gates; no full deployment in this chunk.
