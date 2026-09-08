### Verify provider-specific REST contracts with the configured endpoint

**Context:** Managed invoice inference uses Vertex AI over REST with VM metadata credentials.
**Problem:** A Gemini Developer API `generateContentRequest` wrapper was sent to Vertex `countTokens`. Mock responses accepted it, but the live endpoint rejected it before paid admission.
**Rule:** Validate the exact provider's REST request shape against its reference and a bounded live preflight. Vertex `countTokens` takes `contents`, `model`, and `generationConfig` at the top level. Preserve the full generation schema in the estimate and keep provider diagnostics in private artifacts.
**Applies to:** Managed inference adapters and their boundary tests.
