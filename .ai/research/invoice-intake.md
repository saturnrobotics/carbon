# Invoice Intake Research: Best Practices Survey

## Summary

Researched on 2026-09-06 for a public self-hosting fork. Official SAP, Oracle NetSuite, and Coupa documentation supports a common pattern: capture supplier documents into an editable review stage, retain the evidence, remember confirmed matches, and hand approved data to ordinary invoicing. Extraction is distinct from receiving stock, posting accounting, and settling payment. Carbon already implements portions of this pattern; the proposed work connects and completes them.

## Competitors Surveyed

- **SAP / SAP Ariba** — extraction provenance, invoice exceptions, duplicate detection.
- **Oracle NetSuite** — Bill Capture, correction memory, supplier-specific defaults, purchasing units.
- **Coupa** — invoice uploads, editable drafts, and PO/non-PO handling.
- **Google Cloud** — inference implementation options for the existing private GCP deployment; this is infrastructure research, not an ERP precedent.

## Key Consensus Patterns

### 1. Review precedes ordinary invoice processing

- **NetSuite**: captured documents are reviewed before creating bills; normal bill approval remains applicable. [S1]
- **Coupa**: uploaded invoices produce editable drafts before submission. [S7]
- **SAP**: quantity, receipt, price, tax, and duplicate discrepancies remain explicit reconciliation exceptions. [S5]
- **Rationale**: extracting a document cannot establish that goods arrived, remain in stock, or have been accounted for.

### 2. Remember confirmed decisions with a narrow scope

- **NetSuite**: corrected scanned values can influence subsequent captures; supplier/subsidiary templates and PO values have distinct precedence. [S2, S3]
- **SAP**: templates and extraction confidence assist review, but require confirmation. [S4]
- **Rationale**: company/supplier SKU mappings and approved aliases give repeatability without treating a model guess as master data.

### 3. Keep document facts and proposed values distinguishable

- **SAP**: review exposes extracted fields, normalization, confidence, and source locations. [S4]
- **NetSuite**: reviewers compare extracted and calculated values with the document. [S2]
- **Rationale**: preserve raw extraction, corrected values, applied rules, and approval separately. Never overwrite a human correction during a retry.

### 4. Identity and units need explicit checks

- **SAP**: business duplicate checks consider supplier/company and invoice reference or other document facts. [S6]
- **NetSuite**: purchase units and stock units have defined conversion relationships. [S8]
- **Coupa**: invoice/PO reconciliation includes unit and currency consistency. [S9]
- **Rationale**: an attachment hash identifies bytes, not an economic transaction; a matched item does not establish the purchasing pack size.

## Answers to Research Questions

1. **Does capture post accounting?** The documented patterns separate capture/review from downstream processing. Carbon intake approval should produce a Draft or link evidence to an existing invoice. [S1, S5, S7]
2. **What happens to unknown suppliers/items?** The products support assisted matching and human review. Their public documentation does not justify silently creating unknown Carbon masters. Reuse Carbon's typed creation forms with explicit approval.
3. **What should corrections teach?** Stable supplier identity, supplier SKU, item identity, and purchasing-unit relationships. NetSuite provides precedent for remembering corrected mappings; it does not disclose a model architecture we need to reproduce. [S2, S3]
4. **How should duplicates be detected?** Combine immutable source identity and byte hash with supplier/document identity checks. Ambiguous business matches require review. [S6]
5. **What must numeric review validate?** Line quantity, unit price, discounts, tax, shipping, currency, and document total; units/conversion are separate from item identity. [S2, S5, S8, S9]
6. **Does this require a custom trained classifier?** No. This is an engineering inference from Carbon's existing mappings and documented correction memory. A multimodal extractor plus explicit mapping memory can meet the requested workflow; measure quality before introducing more infrastructure.

## Competitor-Specific Details

### Oracle NetSuite

Bill Capture can retain reviewed documents and recognize corrected values in later captures. Its supplier/subsidiary templates illustrate useful scope boundaries. Carbon should learn on successful approval, rather than on every unfinished edit, to avoid storing accidental choices. This is a deliberate Carbon design decision, not a claim that every competitor behaves identically.

### SAP

Extraction confirmation and invoice exception resolution are distinct. Confidence is advisory; confirmation records a person's decision. Carbon should not represent model confidence as a measured probability of correctness.

### Coupa

AI uploads support PO and non-PO invoices and editable draft review. The consulted documentation does not establish an autonomous vendor/item creation or correction-training implementation.

### Google Cloud

Direct Gemini inference supports document/image input and schema-constrained JSON. A Node worker can use its Compute VM's short-lived metadata access token and the documented prompt permission, without a new SDK or model server. [G1–G4]

Current documentation provides a US multi-region endpoint for the proposed stable models. Configure `us` explicitly; it is not the application's specific Compute region, and there must be no silent global fallback. The documented REST host is `aiplatform.us.rep.googleapis.com`. [G5, G6]

Benchmark the explicitly configured `gemini-3.5-flash` and `gemini-3.5-flash-lite` models. Model IDs, availability, and prices must be verified again at implementation and deployment. Documentation proves supported inputs, not accuracy on the operator's receipts. [G7, G8]

Document AI Invoice/Expense Parser is a later alternative if evaluation shows persistent OCR/table failures. It adds a second processor and does not replace Carbon item classification or approved SKU memory. [G10, G11]

## Recommended Approach for Carbon

1. Add an Invoicing document inbox backed by durable intake records and immutable source references.
2. Reuse document extraction jobs and typed supplier/item forms. Preserve the existing RFQ extraction contract.
3. Save supplier SKU mappings and narrow aliases only when a person approves. Use model suggestions only where confirmed matches do not settle identity.
4. Keep approval atomic, idempotent, and separate from posting, receiving, and settlement.
5. Start with one configurable managed GCP multimodal extractor; evaluate smaller-model substitution rather than building a training pipeline.
6. Keep original documents, learned mappings, credentials, evaluation samples, and operational configuration out of the public repository.

## Sources

- [S1 — Oracle Bill Capture](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_164726334180.html)
- [S2 — Oracle Uploading Vendor Bills](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_1021105256.html)
- [S3 — Oracle Bill Capture Templates](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_1217105627.html)
- [S4 — SAP Viewing and Editing Extraction Results](https://help.sap.com/docs/Next_Gen_SAP_Ariba_Invoicing/5e1b67e024224834ad36dbf5ad02e22a/a9c5e6190f764dc7b705665f9034e9b6.html)
- [S5 — SAP Resolving Invoice Exceptions](https://help.sap.com/docs/buying-invoicing/reconciling-invoices/overview-of-resolving-invoice-exceptions)
- [S6 — SAP Duplicate Invoice Checks](https://help.sap.com/docs/SAP_ERP_SPV/98eed63ea3a544af84eb972dc68b0e84/a971b6531de6b64ce10000000a174cb4.html?locale=en-US&state=PRODUCTION&version=6.17.28)
- [S7 — Coupa AI Invoice Upload](https://docs.coupa.com/en/supplier-documentation/coupa-for-suppliers/the-coupa-supplier-portal-or-csp/features-and-processes-in-the-coupa-supplier-portal/invoices/create-or-edit-an-invoice/submit-invoices-using-the-ai-invoice-upload)
- [S8 — Oracle Multiple Units of Measure](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N2211898.html)
- [S9 — Coupa Create or Edit an Invoice](https://docs.coupa.com/en/supplier-documentation/coupa-for-suppliers/the-coupa-supplier-portal-or-csp/features-and-processes-in-the-coupa-supplier-portal/invoices/create-or-edit-an-invoice)
- [G1 — Google structured output](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output)
- [G2 — Google inference request format](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/inference)
- [G3 — Compute workload authentication](https://docs.cloud.google.com/compute/docs/access/authenticate-workloads)
- [G4 — Model access control](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/access-control)
- [G5 — Model endpoints](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations)
- [G6 — Data processing locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/data-residency)
- [G7 — Model lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)
- [G8 — Flash-Lite capabilities](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite)
- [G9 — Inference pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)
- [G10 — Document AI processors](https://docs.cloud.google.com/document-ai/docs/processors-list)
- [G11 — Document AI pricing](https://cloud.google.com/products/document-ai/pricing)
- [G12 — Billing budgets are alerts](https://docs.cloud.google.com/billing/docs/how-to/budgets)
- [G13 — Data governance and retention conditions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention)

No live documents were submitted to any inference provider during this research.
