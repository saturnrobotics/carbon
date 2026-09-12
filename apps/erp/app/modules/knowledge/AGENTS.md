# Knowledge Module

The canonical read surface (plus one command) that the company knowledge platform's services call on Carbon on behalf of a verified workforce user. It has no UI and no route of its own: every operation is published through the Carbon API v1 manifest (`knowledge_*`) and reachable only by the delegated `workforce` auth kind.

## Key Domain Concepts

- **Workforce caller** — a knowledge service (`knowledge-query`, `knowledge-actions`) presenting its own service token plus the user's IAP assertion. `authenticate.server.ts` resolves it to `authKind: "workforce"` with the caller registry's `allowedOperations`, the principal's `capabilities`, the user's fresh Carbon permissions and an `assurance` verdict.
- **Capability** — what the principal's identity binding grants: `knowledge.read` (the six identity reads), `knowledge.read.pricing` (the one read that discloses money), `carbon.procurement.draft` (the write). Assigned per operation by `KNOWLEDGE_OPERATIONS`.
- **Identity read** — a bounded projection of items, receipts, documents or purchase status that never carries a price or cost field. Pinned on the manifest's response schemas by `knowledge.read.integration.test.ts`.
- **Procurement draft command** — `createProcurementDraft` (`knowledge.mcp.server.ts` → `knowledge.commands.server.ts`): creates or schedules a Draft purchase order through the purchasing transaction. Actor, company and source are server-stamped; `executeAt` defers it to `knowledgeProcurementSchedule`.
- **Disclosure** — knowledge operations stay in the manifest and its committed digest but are filtered out of MCP `search_tools`/`describe_tool`, `/.well-known/mcp.json`, the server instructions and `/api/v1/openapi.json` (`isDisclosedOperation` in `routes/api+/v1+/lib/operations.server.ts`).

## Safety

### Always
- MUST add every new operation to `KNOWLEDGE_OPERATIONS` in `knowledge.server.ts` with its capability — `assertWorkforceAuthorization` refuses anything unlisted, and `knowledge.gate.test.ts` fails when a generated `knowledge_*` operation is missing from it.
- MUST take `companyId` from the auth context (a `companyId` service parameter, injected by the dispatch) and `.eq("companyId", …)` every read; the user-scoped client's RLS is the second boundary, not the first.
- MUST give a new READ a `PERMISSION_OVERRIDES` entry in `scripts/lib/service-metadata.ts` naming the real Carbon permission it depends on (`parts`, `inventory`, `purchasing`); the module-name default (`knowledge:view`) does not exist and would deny every caller.
- MUST validate identifiers and search terms with `knowledgeIdentifier` / `knowledgeItemSearch` before they reach a PostgREST filter string (`.or(...)`), and keep every validator `.strict()`.
- MUST run `pnpm generate:mcp` after touching `knowledge.service.ts`, `knowledge.models.ts` or `knowledge.mcp.server.ts` and commit `tool-manifest.digest.json`.

### Ask First
- Adding a field that names money, cost, margin or a supplier price to any identity read — that is a new capability, not a projection change.
- Adding a second write operation — the procurement draft is the only command, and its authorization is rechecked at scheduled execution time.

### Never
- Serve a knowledge operation to an API key, OAuth connector or in-process session — the gate answers NOT_FOUND on purpose (`base.server.ts`), and `knowledge.gate.test.ts` pins every operation and caller kind.
- Import a `*.server` module from `knowledge.service.ts` — the barrel is client-bundled; put such code in `knowledge.mcp.server.ts` or `knowledge.commands.server.ts`.
- Read `supplierPart.unitPrice`, `itemCost` or any purchase amount anywhere but `getItemSupplierPricing`.

## Validation Commands

```bash
pnpm run generate:mcp && pnpm --silent check:manifest
pnpm --dir apps/erp exec vitest run app/modules/knowledge "app/routes/api+/v1+/lib" test/mcp-tool-permissions.test.ts
pnpm exec turbo run typecheck --filter=erp
```

## Key Data Model

| Table / View | Purpose |
|---|---|
| `item` | `resolveItems` / `getItemIdentity` projection: readable id, revision, MPN, unit of measure, active flag |
| `receipt` / `receiptLine` / `itemLedger` / `trackedEntity` | `getRecentReceipts` / `getRecentReceiptItems`: posted receipts, net ledger quantities, serial and lot identities |
| `purchaseOrder` | `getPurchaseStatus`: status and dates, no amounts |
| `supplierPart` / `supplier` | `getItemSupplierPricing`: active unit price, supplier unit of measure, the supplier's currency |
| `storage.objects` (`private` bucket, `<companyId>/parts/<itemId>`) | `getDocumentReferences`: object keys only, no signed URLs |
| `knowledgeProcurementSchedule` | Deferred procurement draft commands (`executeAt`), idempotent on `(companyId, actorId, action, idempotencyKey)` |
| `knowledge.source` | The single active Carbon purchasing source a draft is attributed to |

## Key Service Functions

- `resolveItems` / `getItemIdentity` — bounded item identity search and lookup (`parts:view`)
- `getRecentReceipts` / `getRecentReceiptItems` — posted receipts and their line identities with reversals (`inventory:view`); the projection is `summarizeReceiptIdentities` in `knowledge.receipts.ts`
- `getDocumentReferences` — item document object keys without minting URLs (`parts:view`)
- `getPurchaseStatus` — one purchase order's status projection (`purchasing:view`)
- `getItemSupplierPricing` — active supplier unit prices for one item, optionally one supplier (`purchasing:view`, capability `knowledge.read.pricing`)
- `createProcurementDraft` (`knowledge.mcp.server.ts`) — schedule or execute the procurement draft command (`purchasing:create`, capability `carbon.procurement.draft`)
- `KNOWLEDGE_OPERATIONS` / `knowledgeCapabilityFor` / `isKnowledgeOperation` (`knowledge.server.ts`) — the allowlist the API gate and the disclosure filters consume

## Related Modules

- **purchasing** — `createProcurementDraft` in `purchasing.service.ts` is the transaction the command path calls
- **items** / **inventory** — own the tables the identity reads project; this module adds no writes to them

## Rules References

- `.claude/rules/authentication-system.md` — the auth kinds and permission claims the gate reads
- `.claude/rules/mcp-tools-reference.md` — manifest generation, digest, dispatch and the disclosure filter
- `.claude/rules/database-patterns.md` — batched reads, no query in a loop
