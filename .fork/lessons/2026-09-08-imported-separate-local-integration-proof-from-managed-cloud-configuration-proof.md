## Separate local integration proof from managed-cloud configuration proof

**Context:** Planning release verification for a small independently deployed service.

**Problem:** A cloud staging environment was presented as necessary when local containers could cover most functional and security behavior.

**Rule:** Prefer isolated local integration tests when requested. Identify the specific managed-cloud boundaries that require live verification and test them with restricted access and synthetic data on the intended deployment. Do not turn a recommended staging topology into an approved requirement.

**Applies to:** Deployment planning, local emulators, and initial cloud acceptance.
