# Negative tests must prove the expected rejection

**Context:** Fork CI exposed a certificate-address check that behaved differently across TLS toolchains, a database crash hidden by negative permission tests, and a full-corpus integration case using a unit-test timeout.

**Problem:** A command's successful execution is not always a positive verification result. Conversely, a failing subprocess can mean broken infrastructure rather than the expected authorization rejection. Local and CI runtime differences concealed both defects.

**Rule:** Prove the semantic outcome: certificate verification must enforce the address, and permission tests must assert an SQL error with the expected SQLSTATE, rejecting connection loss and process failure. Reproduce platform-specific failures with the CI toolchain. Apply runtime workarounds consistently to the relevant development, CI, and deployment definitions without removing permission checks or extensions. Measure cumulative integration fixtures before selecting a bounded per-case deadline; preserve every behavior assertion and avoid retries that hide failures.

**Applies to:** Deployment certificate validation, disposable database security tests, runtime Compose/CI configuration, and full-corpus integration tests.
