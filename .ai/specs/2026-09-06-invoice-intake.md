# Invoice document intake, recognition, and approval

> Status: approved, implementation in progress
> Author: Codex
> Date: 2026-09-06
> Research: ../research/invoice-intake.md
> Implementation plan: ../plans/2026-09-06-invoice-intake.md

## TLDR

Extend Invoicing with a document inbox shared by manual uploads and Mercury/Gmail evidence. Extract document facts, suggest suppliers and typed items, expose corrections beside the original, and remember confirmed identities and purchasing units. One approval creates/enriches a Draft invoice and any explicitly confirmed master records. It does not post accounting, receive inventory, initiate a payment, or settle an invoice. Implement using existing Carbon forms, Supabase storage/Postgres, and Inngest, with a configurable managed GCP inference adapter as the planning default.

The user authorized execution of the full implementation plan, including its managed GCP inference default and deployment. Runtime configuration and acceptance criteria below still require verification before completion.

## Problem Statement

The fork's Mercury import creates/links suppliers and header-only invoices, but never invokes native PDF invoice autofill. Native autofill parses PDFs and has an unmatched-line review modal, yet its mapping action assumes Part, does not remember corrections, and does not support photographed/scanned receipts. Its creation path uses separate Supabase writes. The existing extraction permission and file-path checks are insufficient for private financial evidence.

Example: an invoice contains two bags of 100 fasteners. A user selects Consumable, matches an internal fastener, and confirms BAG → EA with factor 100. The next invoice from that supplier should recognize the same item and pack conversion while extracting its new quantity, price, dates, and tax independently.

## Proposed Solution

### Product flow

1. **Invoicing → Documents** accepts PDF, PNG, and JPEG, or shows a document attached to an imported Mercury payment. The Mercury page continues to show bank evidence and links to the same review.
2. The document appears as Queued/Processing and then Needs review or Ready. Failed extraction retains the source and supports manual entry/retry.
3. A split review screen shows the original document and editable supplier/header/line fields. Each value identifies its origin: document, saved match, default, model suggestion, or manual correction.
4. Unknown supplier: prefill the existing supplier form using extracted name/contact/address. Unknown item: choose Part, Material, Consumable, Tool, or Service and complete that type's existing fields. G/L Account and Fixed Asset remain explicit normal invoice-line choices, not invented item categories. New taxonomy values are company-owned and explicitly confirmed.
5. Existing supplier/item matches are preselected. Ambiguous candidates remain selectable suggestions; a prefix or semantic similarity alone never establishes identity. Identical new-item proposals within one invoice are grouped for one creation decision.
6. Save review preserves work but creates no master records. **Approve and create draft** explicitly confirms the displayed new suppliers/items, creates the draft, and remembers enabled matching choices in one transaction. Known documents can use **Link existing invoice** instead.
7. The resulting invoice remains available through normal Invoicing. For historical documents, the review and invoice show that receipt/payment/accounting treatment still needs to be resolved through the normal explicit flows.

### Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Core object | One intake with many source references and ordered lines | Several uploads/emails/payments may describe one invoice; a payment is not an invoice |
| Existing extraction | Reuse `documentExtraction` for immutable attempts; preserve legacy RFQ contract | Builds through real call sites without forcing RFQ into invoice review |
| Inference | Managed GCP multimodal model, configurable model and explicit US endpoint | Planning default avoids maintaining a model server; adapter allows later replacement |
| Recognition | Confirmed mappings first, exact catalog candidates second, model suggestions last | Repeatability comes from decisions in the database |
| Learning | Successful approval persists stable identities/UoM; unfinished edits do not train | Avoids accidental rules and perpetual financial-field defaults |
| Model autonomy | Structured suggestions only; no tools, writes, email actions, or posting | Uploaded documents are untrusted input |
| New entities | Existing type validators/forms and transaction-compatible creation primitives | Preserve sequences, defaults, tax/shipping state, and subtype relationships |
| Approval | Single Kysely transaction with revision/identity locks | Retrying or concurrent approval must not duplicate anything |
| Inventory/payment | Separate existing actions; approval only produces a draft/evidence link | Purchased quantity does not establish current inventory or outstanding debt |
| Numeric precision | Existing Carbon precision/currency utilities; no model-created balancing values | Preserve purchase units, per-unit precision, and currency settlement rules |
| Permissions | Existing invoicing/purchasing/item-class scopes, applied to every canonical write | A model suggestion cannot grant access or bypass supplier approval |
| Service architecture | Add orchestration in `invoicing.server.ts`; keep models/service in canonical files | Avoid module sprawl and browser imports of database clients |
| Data privacy | Company-scoped private records and file paths; generic source fixtures | Public fork must not contain real receipts, aliases, prompts with business data, or credentials |
| Storage consistency | Immutable source reference is available before approval; attachment copy is retryable | Storage and SQL cannot share a transaction |
| Deployment | Feature branch → integrate with upstream on `saturn/main` → `make deploy` | Preserve the laptop deployment and fork workflow |

### Processing and review states

`NeedsDocument → Queued → Processing → NeedsReview/Ready → Approved`

Additional terminal/recoverable states: `Linked` (evidence linked to existing invoice), `Ignored`, and `Failed`. A failed run can queue a new extraction generation. Ready is derived by server validation; it is never accepted from the client or inferred solely from model confidence.

- Every edit increments `revision`; every reparse increments `generation`.
- Worker claims use a bounded lease on a specific extraction attempt. Results commit only for the active generation. If a user edited since the attempt began, store results as an unapplied suggestion rather than replacing reviewed fields.
- Approved/Linked intakes are immutable except adding evidence or an explicit audited correction of recognition rules. Editing a posted invoice remains governed by existing invoice workflows.
- Approve requests include expected revision and a request idempotency key. Same request/result is repeatable; a different stale revision produces a conflict with no partial writes.
- Queue dispatch follows SQL commit. A scheduled reconciliation job re-dispatches committed Queued attempts and recovers expired leases; it never resets Reviewed/Approved content.

### Intake identity and existing Mercury records

Use a unique company/source/provider identity to make collector retries harmless. Hash verified file bytes; serialize exact-hash ingestion so the same PDF from two channels becomes one intake with two provenance records. Hash matching is company-scoped. For different scans, compare supplier, invoice/reference number, currency, date, and total; present suspected business duplicates for review. A company/supplier/reference lock and a final invoice lookup prevent two simultaneous approvals from independently creating the same invoice. Legitimate reused references require an explicit audited override, not a permanent universal uniqueness constraint on native invoices.

Do not merge two documents merely because totals or vendor names match. Preserve multiple payment links and multiple evidence files. Statements, credit notes, payment confirmations, and files containing multiple invoices are classified for manual resolution; never convert them silently into a positive purchase invoice. Multiple-invoice documents require explicit splitting/selection before approval.

The historical bridge is paginated and resumable:

| Existing state | Intake behavior |
|---|---|
| Pending with a document | Queue extraction using the same ingestion service as uploads |
| Pending without a document | NeedsDocument; no invented invoice lines/date/total from bank data |
| Imported, linked empty Draft | Offer enrichment of that exact draft after review |
| Imported, linked populated/edited Draft | Compare and explicitly map retained/replaced/added lines; never overwrite automatically |
| Linked invoice is not Draft | Evidence-only link; no header, line, stock, or settlement write |
| Ignored | Remain ignored until explicitly restored |
| Sources already point to different invoices | Conflict requiring review; no automatic relinking |

Current Mercury sync skips Gmail discovery on already approved rows. Include a deliberate **Find supporting document again** action for these records; it is not part of every hourly scan. It honors enabled/paused mailboxes, existing readonly credentials, permissions, and provider bounds.

### Extraction contract

Raw input is the immutable uploaded PDF/image. Detect MIME from bytes, inspect ownership, and bound file/page/output size before model calls. Initial limits: 10 MiB PDF, 20 PDF pages, 7 MB inference image, 500 invoice lines. Larger or unsupported inputs remain visible with an actionable manual/split path; never silently truncate pages or lines. Preserve original files even if an inference derivative is made.

Return a versioned structured envelope:

- Document kind; supplier raw name, address, contact/email, tax identifier if present.
- Reference/invoice number, issue/due dates, currency, subtotal, discount, shipping, tax, and total.
- Ordered lines with page/source text, supplier SKU, manufacturer/part number, description, quantity, purchase unit/pack text, unit price, discount, net amount, and tax.
- Null for missing/ambiguous fields; raw text remains available. Page references are hints validated against page count, not guaranteed OCR coordinates.
- Extraction and matching confidence are separate advisory values. Never delete low-confidence fields from the review or claim 0.85 confidence means 85% observed accuracy.

The prompt does not decide canonical IDs. Candidate selection uses bounded, company-scoped data; returned IDs must belong to the supplied candidate set and pass server validation. Do not send the entire supplier/catalog database to the model. A classification request for ambiguous lines includes only required descriptions/specifications and a bounded set of confirmed examples/candidates.

### Recognition and correction memory

Order: confirmed Mercury recipient/supplier alias → supplier SKU mapping → confirmed supplier-specific description/manufacturer alias → exact catalog match → ranked suggestions. Normalize whitespace and case conservatively; preserve punctuation, revisions, dimensions, grades, pack quantities, and leading zeros that distinguish parts. Case-insensitive lookups must escape wildcard characters and refuse multiple matches.

Supplier Part remains the source of truth for supplier SKU → item and purchasing conversion. A new narrow recognition-rule table covers supplier aliases and item-description aliases not represented there. Existing conflicting mappings are displayed for explicit replacement; never silently overwrite them. Replacements deactivate the old rule and create a new version, with an audit reason. New item types do not mutate an existing item's class.

Remember identity, class through the chosen item, and confirmed purchase unit/conversion. Do **not** reuse old quantities, invoice dates/numbers, prices, tax, payment status, bank details, or FX as learned facts. Price changes do not create new items and do not automatically overwrite master item cost/pricing.

For example: supplier SKU FAST-M4-100 + BAG → internal fastener + factor 100. A later EA line or materially different dimensions prompts review despite the SKU match. A supplier email domain alone is a candidate signal, not proof of legal supplier identity.

### Validation and approval semantics

Require a resolved supplier, document kind, unambiguous issue date, currency, total, and each non-comment line's description/type/quantity/price/required typed fields. Invoice number may be absent on a receipt; explicitly acknowledge absence and use the intake identity, never the Mercury payment date as a fabricated number/date.

Keep quantities and money as validated decimal input strings until the existing Carbon numeric boundary. Use company currency precision for settled amounts and Carbon's shared per-unit precision. Explicitly confirm purchase-to-stock conversion and location for inventory items. Compare the computed total with the extracted document total after currency rounding. Reconcile line discounts and document-level charges with visible allocations; do not put all tax on the first line, silently use quantity 1/price 0, or invent a rounding line. Unsupported discounts, credits, ambiguous tax treatment, or missing FX remain review exceptions until expressed through supported native invoice fields.

Approval rechecks permissions and supplier approval policy, item activity/release restrictions, chosen IDs, duplicate identity, totals, document generation/revision, and the linked invoice's Draft status. The transaction creates new masters, an interaction/header/delivery if needed, ordered typed lines, supplier SKU/alias memory, Mercury links, and approval audit facts. Use the existing invoice field conventions (`supplierUnitPrice`, `supplierTaxAmount`, `taxPercent`, `conversionFactor`) and preserve default handling. Do not write generated columns.

Storage copy happens after commit using deterministic destinations. The original remains accessible through the intake; a pending/failed attachment-copy status is visible and retried independently. Successful approval does not claim the file was copied until verified.

## Data Model Changes

Add five company-scoped tables; extend `documentExtraction` additively. Exact DDL is supplied in the implementation plan's migration task; use generated types afterward.

| Table | Canonical fields and constraints |
|---|---|
| `invoiceIntake` | Composite ID/company PK; status, revision/generation; supplier/invoice/extraction FKs; corrected header and new-supplier proposal JSON; historical flag; approval key/by/at; safe error; immutable approval snapshot |
| `invoiceIntakeSource` | Intake FK; provider identity; optional Mercury-import FK; storage bucket/path; SHA256/media/size/name; source kinds upload/mercury/gmail; unique company/source key |
| `invoiceIntakeLine` | Intake FK, stable line key/order; raw facts; corrected decimal quantity/price/tax/discount; item/PO-line/account/asset/native-invoice-line FKs; selected type; purchase/stock units and factor; typed new-item proposal; review/provenance facts |
| `invoiceRecognitionRule` | Kind supplierAlias/itemAlias; stable match key; optional supplier/item/Supplier Part FKs; normalized evidence text; state/version; superseded rule FK; originating intake; explicit audit fields |
| `invoiceIntakeSettings` | One row per company; inference/automatic-intake toggles; daily/monthly budget allowances; historical backfill state/cursor/upper bound; recorded operator; no provider secrets |

`documentExtraction` gains nullable intake FK, generation, input revision, paid-attempt number/operation, schema/prompt/model versions, provider/region, claim token/expiry, reservation time/rate snapshot, and token/cost accounting metadata. Legacy RFQ rows remain valid. Append attempts instead of mutating a completed raw result. An intake attempt requires a valid intake/generation/revision/attempt number and purchaseInvoice type; its active pointer must belong to that same intake/generation.

All new tables have `id('prefix')`, `companyId`, composite PK, audit columns, company-scoped FK indexes, and RLS. Canonical selected IDs are columns with real FKs so foreign-company backups can remap them. JSON contains evidence or uncommitted proposals, never an authoritative replacement for these FKs. Foreign-company restore clears/revalidates unresolved candidate IDs in proposals and queues review rather than accepting stale selections.

Financial intake and invoice extraction SELECT require invoicing view permission; authoritative writes go through permission-checked server/worker transactions. Preserve the authorized RFQ UI/API contract, but make all extraction registration server-owned so clients cannot spoof actors. Storage path ownership and the recorded actor's source access are validated at registration and before any service-role worker read. RFQs must reject financial source paths even when the company prefix matches. Restrictive financial-prefix policies constrain existing permissive company-wide policies; the separate Kanban PostgreSQL isolation script is unrelated.

## API / Service Changes

- Read/list: canonical `invoicing.service.ts`, with company-scoped clients and `{data,error}` returns. Save review/settings/rules, ignore, retry, and approve are permission-checked server transactions because client writes to intake tables are denied.
- Orchestration/transactions: `invoicing.server.ts`, receiving a cached `Kysely` client from the route. Never instantiate database clients in service modules.
- Typed creation primitives: `items.server.ts` and a new canonical `purchasing.server.ts`, accepting a transaction; share pure normalization/default preparation with existing real callers and add parity tests.
- Intake actions: upload registration, save review, approve, link existing, retry/reparse, ignore/restore, find supporting document again, start/status/pause historical ingestion, and recognition-rule correction.
- Jobs: source ingestion/backfill, versioned extraction, and committed-work reconciliation. Integrate with existing Inngest registrations/events and Mercury page completion; dispatch IDs, not document contents.

## UI Changes

Use `InvoiceDocumentInbox`, `InvoiceDocumentReview`, `InvoiceDocumentLines`, and `InvoiceRecognitionRules` under `invoicing/ui/InvoiceDocuments/`. Precedents: Mercury review, `PdfExtractor`, `MapExtractedLinesModal`, `PurchaseInvoiceLineForm`, and existing Supplier/Item creation components. Use current Carbon tables/forms/drawers and Lingui.

Tabs/filters: Needs document, Processing, Needs review, Ready, Approved/Linked, Ignored, Failed. Show supplier, date, total/currency, source badges, new-entity count, and issues. Review shows per-line create/select, fields for actual item class, purchase/stock conversion, numeric discrepancies, duplicate warnings, and saved-match explanations. Group repeated new-item proposals and support approving several Ready documents with per-document results; do not make a cross-document transaction or auto-approve uncertain entries.

A historical flag is a visible review reminder and provenance field, not a new accounting policy. The feature does not provide opening-inventory/WIP import or bypass receipt posting rules.

## Inference and deployment

Default adapter: native Google `generateContent` over Node `fetch`; schema-constrained output validated locally. No new production dependency is required. Configure project, `us` processing location, exact model, limits, and enable flag in ignored deployment settings. Start evaluation with `gemini-3.5-flash`; compare Flash-Lite and choose it only if quality gates pass. Verify IDs/endpoint availability at implementation; no automatic fallback to a different provider or global processing.

Provision a dedicated Compute VM service account with only prompt permission (`aiplatform.endpoints.predict`) and the cloud-platform scope. Obtain short-lived metadata tokens; never store a service-account key. This is a VM-wide identity, not a container-isolated identity. Preserve existing firewall/Tailscale-only access and use existing outbound NAT/TLS. No additional public application endpoint is required.

Default concurrency 2 across all workers and at most 3 total provider calls per generation across extraction, matching, and retries. Preserve successful extraction when matching fails. Bound timeouts and exponential backoff; retain ambiguous-timeout usage reservations. An atomic budget reservation precedes each request; pause further calls when the configured daily/monthly allowance is exhausted. Model pricing is deployment configuration with a verified timestamp; unknown prices or unverified token bounds fail closed for automated calls. Usage/budget persistence is specified in the plan; Cloud Billing budgets are supplementary alerts, not hard caps.

Store each paid attempt's reservation, admission timestamp, operation, price snapshot and actual usage on its `documentExtraction` row. Lock the company's `invoiceIntakeSettings` row before calculating/reserving spend; count actual charge where known and the full reserved maximum where unknown in the original admission window. Stale results still reconcile billing even when their document fields cannot apply. Default proposed allowances are USD 5/day and USD 50/month, using UTC windows and editable under existing settings-update permission. These bound this application's request admission; they are not a guarantee about unrelated cloud usage or provider billing. Default inference is off until the operator enables it; pausing it does not hide imported evidence or prevent manual review.

Originals stay in private Supabase storage. Request/response logging, grounding, and URL/tool use remain off. Do not promise zero retention; managed service governance must be accurately documented. The self-hosted adapter remains an interface possibility, not a second deployment in this plan.

## Acceptance Criteria

- [ ] AC1: Native PDF, scanned PDF, JPEG, and PNG all reach the same editable review; missing fields remain missing.
- [ ] AC2: A new supplier and new Part/Material/Consumable/Tool/Service can be proposed and created with the correct native records through one explicit approval.
- [ ] AC3: A second invoice for a confirmed supplier SKU preselects its item and pack conversion while extracting new price/quantity/date independently.
- [ ] AC4: Manual correction replaces a wrong suggestion; reparse, retry, price change, and concurrent worker results cannot overwrite it or duplicate an item.
- [ ] AC5: Repeated upload, Mercury/Gmail duplicate attachments, installment payments, duplicate approval, and concurrent approval do not duplicate invoices or inventory.
- [ ] AC6: Totals, unit conversion, typed required fields, unsupported document kinds, duplicate conflicts, and absent FX prevent Ready/approval until resolved.
- [ ] AC7: Approval creates/enriches only Draft invoices; linked non-Draft invoices are evidence-only. No inventory ledger, journal, receipt, payment, or settlement is created by approval.
- [ ] AC8: Historical backfill preserves every existing Mercury status/link, resumes after interruption, and respects mailbox pause settings.
- [ ] AC9: Unauthorized same-company users and other-company users cannot read financial evidence, start inference on another file, create unauthorized masters, or spoof server-owned state.
- [ ] AC10: A failed provider call or exhausted budget leaves recoverable queued/review data; retries stay within the per-generation attempt limit.
- [ ] AC11: Source documents, corrected data, FKs, and learned mappings survive backup/restore; foreign-company restore cannot retain usable stale tenant IDs or storage prefixes.
- [ ] AC12: Existing RFQ autofill and ordinary manual purchase-invoice creation still work; native type mapping no longer rewrites non-Parts as Parts.
- [ ] AC13: `make deploy` from the clean integrated branch provisions/configures the adapter and passes private readiness checks; disabling inference pauses new calls without hiding documents.
- [ ] AC14: Model/prompt changes have repeatable evaluation results, explicit versioning, bounded cost, and a rollback configuration.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Incorrect item identity or pack size | High | Exact scoped mappings; dimensions/units preserved; explicit review for conflicts |
| Duplicate stock/accounting from history | High | Draft/evidence-only approval; no receiving/posting/settlement in intake |
| Partial master/invoice writes | High | Transaction-compatible primitives, concurrency tests, native-default parity |
| Wrong-company financial evidence | High | Permission-scoped RLS, server file ownership checks, storage negative tests |
| Provider errors and spending | Medium | Persisted attempts/reservations, bounded retries, pause controls and reconciliation |
| Loss of reviewed facts during reparse | High | Immutable attempts, generation/revision compare-and-swap, applied-field provenance |
| Upstream merge conflicts | Medium | Module-local additions, shared real call sites, no root documentation/config edits |
| Document restore paths | High | Explicit path transforms and foreign-company restore tests |

## Resolved decisions

- [x] **What does Approve do?** Planning decision preserves existing Mercury behavior: create/enrich a Draft or link evidence, with explicit creation of proposed suppliers/items. Posting/receiving/settlement remain separate.
- [x] **Does recognition require training a classifier?** Research/code decision: use approved mappings and bounded model suggestions first; no training pipeline in this implementation.
- [x] **Where does inference run?** Managed AI in GCP using the configured US endpoint. The user authorized this default by requesting execution of the complete plan; the measured evaluation selects the model before historical parsing is enabled.
- [x] **Should historical stock be reconstructed here?** Explicit scope decision: this feature documents and itemizes purchases. Opening stock/WIP remains the separate workflow already discussed; no inferred historical consumption.
- [x] **Can technical side effects run now?** Yes. The user authorized full execution, deployment, and the measured historical run. Financial approval remains explicit; the agent does not approve real purchases during ingestion.

## Changelog

- 2026-09-06: Proposed design based on actual native extraction, item creation, Mercury import, permissions, and backup call sites; managed GCP inference recorded as a planning assumption.
