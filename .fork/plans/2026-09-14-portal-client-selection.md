# Select a compatible Portal operator client

- [x] Confirm the normal shell selects an older client while a compatible standalone client is installed.
- [x] Add bounded version checks and automatic installed Homebrew libpq discovery; preserve TLS and normal direct connections.
- [x] Verify selection, both entry points, and the Portal Python regression suite.
- [x] Prove old-client rejection and selected-client success on the same authenticated private connection, without a PATH override.
- [ ] Integrate through normal PR/CI; no full deployment in this chunk.
