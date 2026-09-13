# Audit every caller of shared request middleware

Context → A deployment readiness fix corrected ERP's loopback host after strict session-host validation was added.

Problem → MES inherited a separate loopback probe, while job discovery and callback registration used another internal hostname. Fixing the first failing health probe did not cover those consumers.

Rule → Trace shared middleware changes across every application and non-browser caller before rollout. Verify probe response contracts separately, and check both job discovery and the URLs registered for later callbacks. Execute the generated requests against real listeners and the existing deployment without relaxing authentication.

Applies to → Deployment probes, background-job callback registration, and shared root middleware.
