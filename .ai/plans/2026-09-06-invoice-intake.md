# Invoice document intake — implementation plan

**Spec:** `.ai/specs/2026-09-06-invoice-intake.md`
**Research:** `.ai/research/invoice-intake.md`
**Branch:** `feature/invoice-intake`, created from `saturn/main`
**Status:** Approved; implementation in progress.

The user authorized execution of this full plan, including its managed GCP inference default and deployment. The requested interaction remains unchanged: upload/collect → parse → select/create typed masters → approve/correct → remember.

## Progress

- [x] Task 1: Add durable intake, recognition, settings, and extraction-attempt schema
- [x] Task 2: Regenerate database types and verify migration compatibility
- [x] Task 3: Implement review contracts and numeric/state validation
- [x] Task 4: Implement private source registration and duplicate handling
- [x] Task 5: Implement bounded GCP inference and durable job execution
- [x] Task 6: Implement deterministic recognition and correction memory
- [x] Task 7: Implement atomic supplier/item/invoice approval
- [x] Task 8: Build document inbox and typed review UI
- [x] Task 9: Connect Mercury/Gmail and resume historical documents
- [x] Task 10: Verify backups, restore paths, and existing-flow compatibility
- [x] Task 11: Add repeatable laptop deployment configuration
- [ ] Task 12: Evaluate extraction quality and verify the complete workflow
- [ ] Task 13: Integrate upstream, deploy, and enable a measured historical run

## Dependencies

Task 2 immediately follows Task 1. Task 3 requires Task 2. Tasks 4, 5, and 6 can be developed independently after Task 3 using its shared contracts. Task 7 requires Tasks 3, 4, and 6. Task 8 requires Tasks 4–7. Task 9 requires Tasks 4–8. Task 10 can begin after Task 2, but must finish after Task 9. Task 11 can proceed alongside application tasks once Task 5's configuration is fixed. Task 12 requires Tasks 1–11. Task 13 requires successful Task 12 verification and authorization to implement/deploy. Live model evaluation requires the deployed worker and VM identity; after offline and browser checks pass, deploy the integrated code with company inference disabled, run the synthetic evaluation in isolated test companies, then enable the measured historical run only after its quality gate passes.

## Execution rules and boundaries

- This file is the live implementation checklist. Check tasks only after their verification passes.
- Read the root router, `.ai/lessons.md`, the relevant module guides, and the linked spec before modifying code. Preserve existing sales RFQ behavior and existing invoice/stock/payment posting rules.
- Use `corepack pnpm` in this workspace. Root package names are `erp`, `@carbon/jobs`, and `@carbon/database`; ERP has no `test` script, so use its Vitest executable.
- Run integration tests only against an explicitly configured existing local database. Do not rebuild/reset any database. Use a new `INVOICE_INTAKE_TEST_DATABASE_URL` with localhost-only validation modeled on `mercury.integration.test.ts`; require it to be set, and fail rather than skip the dedicated suite.
- Keep test credentials in ignored local configuration. Fixture companies and documents are synthetic; integration tests clean only their own fixture IDs.
- New code stays under existing module/package/deployment directories. Do not edit root README, Makefile, AGENTS, or environment examples for this feature. Use nested deployment documentation. Do not commit real business documents, aliases, private prompts/evaluation results, hostnames, project IDs, or secrets.
- Do not rename/drop existing business tables. Do not bypass supplier approval, engineering release, multi-tenancy, or per-class creation permissions. A stored procedure/helper is not authorization.
- Provider calls and storage operations run outside approval transactions. Database clients are created by existing `.server` factories and passed to helpers.

### Schema execution notes

- No existing development database was available. Validation uses a newly created, isolated localhost-only test instance restored from a retained schema-only archive (zero table-data entries) and its matching migration ledger. No existing database was reset or rebuilt. The archive's database-specific scheduling extension is not needed by these tests; no scheduled jobs or production data were restored.
- Generated migrations are `20260907030842_invoice-intake.sql` and `20260907031408_invoice-intake-company-selections.sql`. The latter strengthens payment-term and cost-center references after catalog inspection confirmed both are company scoped. Applied migrations remain immutable.
- The initial migration also rejects non-finite inference budgets and foreign source paths and explicitly grants authorized financial-source reading. Nine TAP cases, including grouped constraint and RLS assertions, pass through `supabase test db` against the isolated instance. The canonical `generate:types` command succeeded; generated output includes the five tables and extraction-attempt fields.
- Test connection configuration and command logs are kept under ignored deployment-local artifacts. Run Supabase migration commands with that explicit test database URL; the development wrapper assumes its own worktree stack and must not provision an unrelated stack for this verification.

## Task 1: Add durable intake, recognition, settings, and extraction-attempt schema

**Depends on:** none
**Files:**
- Create: the exact migration file emitted by `corepack pnpm db:migrate:new invoice-intake` under `packages/database/supabase/migrations/`.
- Create: `packages/database/supabase/tests/invoice-intake.test.sql`.
- Copy from (precedent): `packages/database/supabase/migrations/20260906203248_mercury-payment-import.sql` and `packages/database/supabase/tests/mercury-import.test.sql`.

**Steps:**
1. Create a fresh migration with the command above. Never choose or backdate its timestamp. Before applying, verify every referenced native FK target against the current schema. If a target has changed since planning, STOP and update this plan; do not drop tenant constraints to make the migration pass.
2. Put the following complete base DDL into that generated migration. Native entity indexes enable composite tenant FKs without changing native primary keys. `account` is company-group scoped and is therefore a single-ID FK plus explicit group validation at approval.

```sql
-- New company-scoped relationships use composite foreign keys.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier','item','supplierPart','purchaseInvoice',
    'purchaseInvoiceLine','purchaseOrderLine','fixedAsset','location','storageUnit',
    'supplierContact','supplierLocation'] LOOP
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I ("id","companyId")',
      t || '_invoice_intake_tenant_key', t);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public."invoiceIntakeSettings" (
  "id" text NOT NULL DEFAULT id('iis'),
  "companyId" text NOT NULL REFERENCES public."company"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "automaticMercuryIntake" boolean NOT NULL DEFAULT true,
  "dailyBudgetUsd" numeric NOT NULL DEFAULT 5 CHECK ("dailyBudgetUsd" >= 0),
  "monthlyBudgetUsd" numeric NOT NULL DEFAULT 50 CHECK ("monthlyBudgetUsd" >= 0),
  "backfillStatus" text NOT NULL DEFAULT 'Idle'
    CHECK ("backfillStatus" IN ('Idle','Queued','Running','Paused','Completed','Failed')),
  "backfillCursor" jsonb,
  "backfillUpperBound" timestamptz,
  "backfillCounts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "lastErrorCode" text,
  "createdBy" text NOT NULL REFERENCES public."user"("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"("id"), "updatedAt" timestamptz,
  PRIMARY KEY ("id","companyId"), UNIQUE ("companyId")
);

CREATE TABLE IF NOT EXISTS public."invoiceIntake" (
  "id" text NOT NULL DEFAULT id('ini'),
  "companyId" text NOT NULL REFERENCES public."company"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'NeedsDocument' CHECK ("status" IN
    ('NeedsDocument','Queued','Processing','NeedsReview','Ready','Approved','Linked','Ignored','Failed')),
  "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "generation" integer NOT NULL DEFAULT 0 CHECK ("generation" >= 0),
  "supplierId" text, "purchaseInvoiceId" text, "activeExtractionId" text,
  "locationId" text, "paymentTermId" text REFERENCES public."paymentTerm"("id"),
  "invoiceSupplierId" text, "invoiceSupplierContactId" text, "invoiceSupplierLocationId" text,
  "documentKind" text NOT NULL DEFAULT 'unknown',
  "header" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "newSupplier" jsonb, "historical" boolean NOT NULL DEFAULT false,
  "approvalKey" text, "approvalSnapshot" jsonb,
  "approvedBy" text REFERENCES public."user"("id"), "approvedAt" timestamptz,
  "attachmentStatus" text NOT NULL DEFAULT 'None'
    CHECK ("attachmentStatus" IN ('None','Pending','Complete','Failed')),
  "lastErrorCode" text,
  "createdBy" text NOT NULL REFERENCES public."user"("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"("id"), "updatedAt" timestamptz,
  PRIMARY KEY ("id","companyId"), UNIQUE ("companyId","approvalKey"),
  FOREIGN KEY ("supplierId","companyId") REFERENCES public."supplier"("id","companyId"),
  FOREIGN KEY ("locationId","companyId") REFERENCES public."location"("id","companyId"),
  FOREIGN KEY ("invoiceSupplierId","companyId") REFERENCES public."supplier"("id","companyId"),
  FOREIGN KEY ("invoiceSupplierContactId","companyId") REFERENCES public."supplierContact"("id","companyId"),
  FOREIGN KEY ("invoiceSupplierLocationId","companyId") REFERENCES public."supplierLocation"("id","companyId"),
  FOREIGN KEY ("purchaseInvoiceId","companyId") REFERENCES public."purchaseInvoice"("id","companyId"),
  FOREIGN KEY ("activeExtractionId","companyId") REFERENCES public."documentExtraction"("id","companyId"),
  CHECK (("status" NOT IN ('Approved','Linked')) OR
    ("purchaseInvoiceId" IS NOT NULL AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public."invoiceIntakeSource" (
  "id" text NOT NULL DEFAULT id('ins'),
  "companyId" text NOT NULL REFERENCES public."company"("id") ON DELETE CASCADE,
  "intakeId" text NOT NULL, "mercuryImportId" text,
  "kind" text NOT NULL CHECK ("kind" IN ('upload','mercury','gmail')),
  "sourceKey" text NOT NULL,
  "storageBucket" text, "storagePath" text,
  "sha256" text CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  "mediaType" text, "byteSize" bigint CHECK ("byteSize" >= 0), "fileName" text,
  "provenance" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdBy" text NOT NULL REFERENCES public."user"("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"("id"), "updatedAt" timestamptz,
  PRIMARY KEY ("id","companyId"), UNIQUE ("companyId","kind","sourceKey"),
  FOREIGN KEY ("intakeId","companyId") REFERENCES public."invoiceIntake"("id","companyId") ON DELETE CASCADE,
  FOREIGN KEY ("mercuryImportId","companyId") REFERENCES public."mercuryTransactionImport"("id","companyId"),
  CHECK (("storageBucket" IS NULL) = ("storagePath" IS NULL)),
  CHECK ("storagePath" IS NULL OR ("sha256" IS NOT NULL AND "mediaType" IS NOT NULL AND "byteSize" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public."invoiceIntakeLine" (
  "id" text NOT NULL DEFAULT id('inl'),
  "companyId" text NOT NULL REFERENCES public."company"("id") ON DELETE CASCADE,
  "intakeId" text NOT NULL, "lineKey" text NOT NULL, "sortOrder" integer NOT NULL,
  "raw" jsonb NOT NULL DEFAULT '{}'::jsonb, "description" text,
  "supplierSku" text, "manufacturerPartNumber" text,
  "quantity" numeric, "supplierUnitPrice" numeric, "discountAmount" numeric,
  "supplierTaxAmount" numeric, "taxPercent" numeric, "supplierShippingCost" numeric,
  "documentLineTotal" numeric,
  "itemId" text, "purchaseOrderLineId" text, "accountId" text REFERENCES public."account"("id"),
  "assetId" text, "purchaseInvoiceLineId" text,
  "locationId" text, "storageUnitId" text,
  "costCenterId" text REFERENCES public."costCenter"("id"),
  "lineType" text CHECK ("lineType" IN ('Part','Material','Consumable','Tool','Service','G/L Account','Fixed Asset','Comment')),
  "purchaseUnit" text, "stockUnit" text, "conversionFactor" numeric CHECK ("conversionFactor" > 0),
  "newItem" jsonb, "review" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdBy" text NOT NULL REFERENCES public."user"("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"("id"), "updatedAt" timestamptz,
  PRIMARY KEY ("id","companyId"), UNIQUE ("companyId","intakeId","lineKey"),
  FOREIGN KEY ("intakeId","companyId") REFERENCES public."invoiceIntake"("id","companyId") ON DELETE CASCADE,
  FOREIGN KEY ("itemId","companyId") REFERENCES public."item"("id","companyId"),
  FOREIGN KEY ("purchaseOrderLineId","companyId") REFERENCES public."purchaseOrderLine"("id","companyId"),
  FOREIGN KEY ("locationId","companyId") REFERENCES public."location"("id","companyId"),
  FOREIGN KEY ("storageUnitId","companyId") REFERENCES public."storageUnit"("id","companyId"),
  FOREIGN KEY ("assetId","companyId") REFERENCES public."fixedAsset"("id","companyId"),
  FOREIGN KEY ("purchaseInvoiceLineId","companyId") REFERENCES public."purchaseInvoiceLine"("id","companyId"),
  CHECK ("itemId" IS NULL OR "newItem" IS NULL)
);

CREATE TABLE IF NOT EXISTS public."invoiceRecognitionRule" (
  "id" text NOT NULL DEFAULT id('irr'),
  "companyId" text NOT NULL REFERENCES public."company"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('supplierAlias','itemAlias')),
  "matchKey" text NOT NULL, "sourceText" text NOT NULL,
  "supplierId" text NOT NULL, "itemId" text, "supplierPartId" text,
  "purchaseUnit" text, "stockUnit" text, "conversionFactor" numeric CHECK ("conversionFactor" > 0),
  "active" boolean NOT NULL DEFAULT true, "version" integer NOT NULL DEFAULT 1,
  "supersedesId" text, "intakeId" text,
  "createdBy" text NOT NULL REFERENCES public."user"("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"("id"), "updatedAt" timestamptz,
  PRIMARY KEY ("id","companyId"),
  FOREIGN KEY ("supplierId","companyId") REFERENCES public."supplier"("id","companyId"),
  FOREIGN KEY ("itemId","companyId") REFERENCES public."item"("id","companyId"),
  FOREIGN KEY ("supplierPartId","companyId") REFERENCES public."supplierPart"("id","companyId"),
  FOREIGN KEY ("supersedesId","companyId") REFERENCES public."invoiceRecognitionRule"("id","companyId"),
  FOREIGN KEY ("intakeId","companyId") REFERENCES public."invoiceIntake"("id","companyId"),
  CHECK (("kind" = 'supplierAlias' AND "itemId" IS NULL AND "supplierPartId" IS NULL)
    OR ("kind" = 'itemAlias' AND "itemId" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "invoiceRecognitionRule_supplier_match_key"
  ON public."invoiceRecognitionRule" ("companyId","matchKey") WHERE "active" AND "kind" = 'supplierAlias';
CREATE UNIQUE INDEX IF NOT EXISTS "invoiceRecognitionRule_item_match_key"
  ON public."invoiceRecognitionRule" ("companyId","supplierId","matchKey") WHERE "active" AND "kind" = 'itemAlias';
CREATE INDEX IF NOT EXISTS "invoiceIntakeSource_hash_idx" ON public."invoiceIntakeSource" ("companyId","sha256");
CREATE INDEX IF NOT EXISTS "invoiceIntake_queue_idx" ON public."invoiceIntake" ("companyId","status","createdAt");

ALTER TABLE public."documentExtraction"
  ADD COLUMN IF NOT EXISTS "intakeId" text,
  ADD COLUMN IF NOT EXISTS "generation" integer,
  ADD COLUMN IF NOT EXISTS "inputRevision" integer,
  ADD COLUMN IF NOT EXISTS "attemptNumber" integer,
  ADD COLUMN IF NOT EXISTS "operation" text,
  ADD COLUMN IF NOT EXISTS "schemaVersion" text,
  ADD COLUMN IF NOT EXISTS "promptVersion" text,
  ADD COLUMN IF NOT EXISTS "modelId" text,
  ADD COLUMN IF NOT EXISTS "provider" text,
  ADD COLUMN IF NOT EXISTS "processingRegion" text,
  ADD COLUMN IF NOT EXISTS "claimToken" text,
  ADD COLUMN IF NOT EXISTS "leaseUntil" timestamptz,
  ADD COLUMN IF NOT EXISTS "reservedCostUsd" numeric,
  ADD COLUMN IF NOT EXISTS "reservedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "priceSnapshot" jsonb,
  ADD COLUMN IF NOT EXISTS "actualCostUsd" numeric,
  ADD COLUMN IF NOT EXISTS "usage" jsonb,
  ADD COLUMN IF NOT EXISTS "billingState" text;
ALTER TABLE public."documentExtraction" DROP CONSTRAINT IF EXISTS "documentExtraction_intake_fkey";
ALTER TABLE public."documentExtraction" ADD CONSTRAINT "documentExtraction_intake_fkey"
  FOREIGN KEY ("intakeId","companyId") REFERENCES public."invoiceIntake"("id","companyId");
ALTER TABLE public."documentExtraction" DROP CONSTRAINT IF EXISTS "documentExtraction_intake_attempt_check";
ALTER TABLE public."documentExtraction" ADD CONSTRAINT "documentExtraction_intake_attempt_check" CHECK (
  "intakeId" IS NULL OR ("documentType" = 'purchaseInvoice'
    AND "generation" IS NOT NULL AND "generation" >= 0
    AND "inputRevision" IS NOT NULL AND "inputRevision" >= 0
    AND "attemptNumber" IS NOT NULL AND "attemptNumber" BETWEEN 1 AND 3
    AND "operation" IS NOT NULL AND "operation" IN ('extract','match'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "documentExtraction_intake_attempt_key"
  ON public."documentExtraction" ("companyId","intakeId","generation","attemptNumber") WHERE "intakeId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "documentExtraction_intake_idx" ON public."documentExtraction" ("companyId","intakeId");
CREATE INDEX IF NOT EXISTS "documentExtraction_budget_idx" ON public."documentExtraction" ("companyId","reservedAt") WHERE "intakeId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "documentExtraction_active_identity_key"
  ON public."documentExtraction" ("id","intakeId","companyId","generation");
ALTER TABLE public."invoiceIntake" DROP CONSTRAINT IF EXISTS "invoiceIntake_active_attempt_fkey";
ALTER TABLE public."invoiceIntake" ADD CONSTRAINT "invoiceIntake_active_attempt_fkey"
  FOREIGN KEY ("activeExtractionId","id","companyId","generation")
  REFERENCES public."documentExtraction" ("id","intakeId","companyId","generation");

-- Index every FK in the new tables, plus the company/actor lookups.
DO $$
DECLARE t text; c record;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoiceIntakeSettings','invoiceIntake','invoiceIntakeSource','invoiceIntakeLine','invoiceRecognitionRule'] LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I ("companyId")', t || '_company_idx', t);
    FOR c IN SELECT DISTINCT a.attname
      FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey)
      WHERE k.conrelid = format('public.%I',t)::regclass AND k.contype = 'f' AND a.attname <> 'companyId'
    LOOP
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (%I)', left(t || '_' || c.attname || '_idx',63),t,c.attname);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "SELECT" ON public.%I', t);
    EXECUTE format('CREATE POLICY "SELECT" ON public.%I FOR SELECT TO authenticated USING ("companyId" = ANY ((SELECT get_companies_with_employee_permission(''invoicing_view''))::text[]))', t);
    EXECUTE format('DROP POLICY IF EXISTS "INSERT" ON public.%I', t);
    EXECUTE format('CREATE POLICY "INSERT" ON public.%I FOR INSERT TO authenticated WITH CHECK (false)', t);
    EXECUTE format('DROP POLICY IF EXISTS "UPDATE" ON public.%I', t);
    EXECUTE format('CREATE POLICY "UPDATE" ON public.%I FOR UPDATE TO authenticated USING (false) WITH CHECK (false)', t);
    EXECUTE format('DROP POLICY IF EXISTS "DELETE" ON public.%I', t);
    EXECUTE format('CREATE POLICY "DELETE" ON public.%I FOR DELETE TO authenticated USING (false)', t);
  END LOOP;
END $$;

-- Preserve RFQ behavior while closing financial staging access.
DROP POLICY IF EXISTS "SELECT" ON public."documentExtraction";
CREATE POLICY "SELECT" ON public."documentExtraction" FOR SELECT TO authenticated USING (
  ("documentType" = 'purchaseInvoice' AND "companyId" = ANY ((SELECT get_companies_with_employee_permission('invoicing_view'))::text[])) OR
  ("documentType" <> 'purchaseInvoice' AND "intakeId" IS NULL AND "companyId" = ANY ((SELECT get_companies_with_employee_role())::text[]))
);
DROP POLICY IF EXISTS "INSERT" ON public."documentExtraction";
CREATE POLICY "INSERT" ON public."documentExtraction" FOR INSERT TO authenticated WITH CHECK (
  false
);
DROP POLICY IF EXISTS "UPDATE" ON public."documentExtraction";
CREATE POLICY "UPDATE" ON public."documentExtraction" FOR UPDATE TO authenticated USING (
  false
) WITH CHECK (
  false
);
DROP POLICY IF EXISTS "DELETE" ON public."documentExtraction";
CREATE POLICY "DELETE" ON public."documentExtraction" FOR DELETE TO authenticated USING (
  false
);

-- Financial sources and any associated copies live under the protected namespace.
-- Restrictive policies also constrain any existing permissive company-wide policy.
DROP POLICY IF EXISTS "invoice_intake_read" ON storage.objects;
CREATE POLICY "invoice_intake_read" ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated USING (
  split_part(name,'/',2) <> 'invoice-intake' OR
  (bucket_id = 'private' AND split_part(name,'/',1) = ANY
    ((SELECT get_companies_with_employee_permission('invoicing_view'))::text[]))
);
DROP POLICY IF EXISTS "invoice_intake_insert" ON storage.objects;
CREATE POLICY "invoice_intake_insert" ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (split_part(name,'/',2) <> 'invoice-intake');
DROP POLICY IF EXISTS "invoice_intake_update" ON storage.objects;
CREATE POLICY "invoice_intake_update" ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (split_part(name,'/',2) <> 'invoice-intake') WITH CHECK (split_part(name,'/',2) <> 'invoice-intake');
DROP POLICY IF EXISTS "invoice_intake_delete" ON storage.objects;
CREATE POLICY "invoice_intake_delete" ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING (split_part(name,'/',2) <> 'invoice-intake');
```

3. SQL tests assert five table PKs/audit columns/indexes, composite FK rejection, read permissions, denied client writes/server-state spoofing, attempt invariants, protected storage policies, financial extraction restrictions, and unchanged authorized RFQ reading. All extraction registration mutations now go through the authenticated API/server writer, preventing a client from spoofing the recorded actor. Validate that an active extraction belongs to this intake/generation when setting the pointer; test that a same-company different-intake attempt cannot be selected. Test finite numeric rejection at the application boundary; raw staging may remain incomplete, but no non-finite value may become Ready.
4. Verify no additional permissive legacy extraction policy bypasses the new policy set. Where the catalog differs, stop and revise explicitly. Apply all schema and application changes together at eventual deployment; a schema-only production rollout would break the legacy invoice extraction writer until Task 4 redirects it.

**Verify:**
```bash
corepack pnpm db:migrate
corepack pnpm --filter @carbon/database exec supabase test db supabase/tests/invoice-intake.test.sql
# Expected: migration succeeds on the existing local database; every SQL assertion passes.
```

**Out of scope:** production execution during planning, database reset, new auth scopes, changing native invoice posting tables' business columns.

## Task 2: Regenerate database types and verify migration compatibility

**Depends on:** Task 1
**Files:**
- Regenerate: `packages/database/src/types.ts` and other outputs of the canonical generator; never edit them manually.
- Inspect: `packages/jobs/manifests/schema.json` through the backup gate.

**Steps:**
1. Run the canonical generator immediately after migration and before typechecking.
2. Confirm all new tables and extraction fields appear. Review generated changes for unrelated local-schema pollution; do not include tables from other unfinished work.
3. Run read-only dataset/backup checks. New tables do not need rename mappings. If an unexpected dropped table appears, trace its real migrations before changing backup manifests.

**Verify:**
```bash
corepack pnpm run generate:types
corepack pnpm db:check:datasets
corepack pnpm db:check:backups
# Expected: generated types include invoiceIntake and attempts; both compatibility checks succeed.
```

**Out of scope:** changing seed business data or accepting phantom backup-manifest tables.

## Task 3: Implement review contracts and numeric/state validation

**Depends on:** Task 2
**Files:**
- Modify: `apps/erp/app/modules/invoicing/invoicing.models.ts`, `invoicing.service.ts`, `index.ts`.
- Create: `apps/erp/app/modules/invoicing/invoice-intake.utils.ts`, `invoice-intake.models.test.ts`.
- Create: `packages/jobs/src/invoice-intake/contracts.ts`, `contracts.test.ts`.
- Copy from (precedent): existing purchase invoice validators, `packages/jobs/src/payment-sync/matching.ts`, shared precision utilities.

**Steps:**
1. Define versioned extraction DTOs in the jobs contracts and export the pure contracts through `packages/jobs/src/index.ts`; retain UI validators in canonical invoicing models. Share one DTO contract, not two independently evolving schemas.
2. Define `validateInvoiceReview(review, context): ReviewValidation`, `getInvoiceReviewReadiness(review, context)`, and `getInvoiceIntakeTransition(current, action)`. Context contains current native item types, supported units, permissions, currency precision, and linked invoice status.
3. Represent missing fields as null, not quantity 1 or price 0. Validate document kind, dates with `@internationalized/date`, finite quantities/prices, tax amount/rate pair, explicit UoM conversion, native typed requirements, line identity, and currency-rounded totals.
4. Show document-level discounts/tax/shipping as explicit review allocations. Proportional allocation can be proposed and displayed, but cannot silently become an invoice fact. Preserve source amounts separately; block unsupported representation instead of inventing a balancing line.
5. Keep candidate identity/class/UoM and each field's origin separate from raw extraction confidence. Store a typed immutable approval snapshot and per-line correction provenance.

**Verify:**
```bash
corepack pnpm --dir apps/erp exec vitest run app/modules/invoicing/invoice-intake.models.test.ts
corepack pnpm --filter @carbon/jobs exec vitest run src/invoice-intake/contracts.test.ts
# Expected: missing/ambiguous dates, fractional prices, JPY/three-decimal currency, pack conversions,
# tax/discount discrepancies, statements/credits, and stale transitions all have explicit outcomes.
```

**Out of scope:** changing tax accounting policy, exchange-rate conventions, or native posting math.

## Task 4: Implement private source registration and duplicate handling

**Depends on:** Task 3
**Files:**
- Create: `apps/erp/app/modules/invoicing/invoicing.server.ts`, `invoice-intake.ingestion.test.ts`.
- Modify: `apps/erp/app/modules/invoicing/invoicing.service.ts`, `index.ts`.
- Modify: `apps/erp/app/modules/documents/documents.service.ts`, `documents.models.ts`.
- Modify: `apps/erp/app/routes/api+/document-extraction.ts`.
- Create: `apps/erp/app/routes/api+/invoice-intake.upload.ts`, `invoice-intake.$intakeId.action.ts`.
- Create: `packages/jobs/src/invoice-intake/ingestion.ts`, `ingestion.test.ts`.
- Extend: the generated invoice-intake migration and `packages/database/supabase/tests/invoice-intake.test.sql` if additional existing storage policies need constrained exclusions.
- Copy from (precedent): Mercury attachment hashing and the financial storage policies in `20260906203248_mercury-payment-import.sql`.

**Steps:**
1. Implement `registerInvoiceSource(db, storage, actor, input): Promise<{intakeId,sourceId,existing}>` with a pure validated source contract shared by HTTP and collectors. Accept uploaded bytes or a server-validated owned storage reference; never trust an arbitrary browser path or URL.
2. Verify byte signature, limits and source ownership before queueing. Copy/register originals under `private` bucket, `companyId/invoice-intake/intakeId/source/hash-name`; service-owned writes and the migration's restrictive policies protect this namespace. Hash verified bytes. With company/hash and provider-identity locks, add provenance to an existing intake or create a new one.
3. Keep payment-only sources legal with no file and NeedsDocument state. Retain source contents/IDs even if a collector retries. A provider identity associated with different bytes becomes an explicit revision/conflict, not an overwrite.
4. Move purchase-invoice extraction registration behind invoicing permission and server-owned writes. Keep the authorized RFQ request/response contract but route its registration through the same validated server writer. On both registration and worker execution, validate the recorded actor's actual source access; RFQ cannot read Mercury/intake financial namespaces by relabeling them `salesRfq`. Verify active actor membership and source ownership before service-role reads, even for old manually staged rows.
5. Restrict financial storage prefixes, including permissive-policy exclusions. Verify signed viewing URLs are issued only to authorized users and are never persisted. Copy failures cannot erase originals.
6. Implement suspected business duplicate lookup without a hard global native invoice-reference constraint. Returned candidates are company-scoped; merge/link decisions are explicit actions with revisions.
7. Request-scoped Supabase clients perform reads only for intake tables. Save/ignore/retry/settings/rule mutations use permission-checked Kysely transactions in `invoicing.server.ts`, because direct authenticated writes are deliberately denied. Validate all canonical header/line references on save as well as approval. Preserve Kanban schema-isolation SQL unchanged.

**Verify:**
```bash
corepack pnpm --dir apps/erp exec vitest run app/modules/invoicing/invoice-intake.ingestion.test.ts
corepack pnpm --filter @carbon/jobs exec vitest run src/invoice-intake/ingestion.test.ts
corepack pnpm --filter @carbon/database exec supabase test db supabase/tests/invoice-intake.test.sql
# Expected: simultaneous equal-byte uploads yield one intake; two sources remain; path spoofing,
# MIME mismatch, oversized files, cross-company access, and private-prefix bypass are rejected.
```

**Out of scope:** a general document-management rewrite or making storage public for inference.

## Task 5: Implement bounded GCP inference and durable job execution

**Depends on:** Tasks 3 and 4
**Files:**
- Create: `packages/jobs/src/invoice-intake/provider.ts`, `provider.test.ts`, `worker.ts`, `worker.test.ts`.
- Create: `packages/jobs/src/inngest/functions/extraction/invoice-intake.ts`.
- Modify: `packages/jobs/src/inngest/functions/extraction/extract-document.ts`, `schemas.ts`, `index.ts`.
- Modify: `packages/jobs/src/inngest/index.ts`, `packages/lib/src/events.ts`, `packages/lib/src/trigger.ts`.
- Modify: `packages/env/src/index.ts` for optional server-only configuration.
- Copy from (precedent): current extraction job, Mercury per-company execution guard, existing safe provider error handling.

**Steps:**
1. Define `InvoiceDocumentProvider.extract(input): Promise<ExtractionResult>` and `suggestMatches(input): Promise<MatchSuggestions>`. Implement native Google REST with existing Node fetch; retain a fake provider for tests and legacy extraction for RFQs.
2. Config: `INVOICE_INTAKE_ENABLED`, `INVOICE_AI_PROJECT`, `INVOICE_AI_LOCATION=us`, `INVOICE_AI_MODEL`, input/output token prices with their verification date, and bounded token/file/time limits. Use the documented `https://aiplatform.us.rep.googleapis.com/v1/projects/.../locations/us/publishers/google/models/...:generateContent` template, validating project/model segments. No untrusted base URL or global fallback.
3. Retrieve metadata tokens using the required header and cache by `expires_in` with early refresh using monotonic time. Never serialize tokens into jobs/state/logs. Use JSON schema response MIME/type and local Zod validation. The model receives inline PDF/image bytes, not a publicly accessible URL.
4. Claim `(intake,generation,attemptNumber)` under a row lock, recording operation (`extract` or `match`), input revision, lease token, model/prompt/schema version and paid-attempt number. Extraction and optional matching share the persisted maximum of three provider calls per generation; a 401 resend also consumes an attempt. Preserve successful extraction when matching fails. Use a 120-second request timeout and five-minute lease; stale completions cannot apply document fields but must still reconcile usage against their original attempt. Set the new invoice-intake Inngest function's retries to zero; the database worker owns all provider retries.
5. Enforce two active attempts across workers/duplicate dispatch/reconciliation, using a shared admission lock and persisted leases. Before each provider call, lock settings and sum UTC-day/month actual-or-reserved charges by `reservedAt`, not document creation time. Insert/reserve the paid attempt with a rate/model snapshot and admission timestamp in that transaction. Require verified count-token support or a documented conservative token bound before live enablement, including reasoning in output cost. Unknown price/bound pauses inference. Reconcile actual usage on success, retain reservation for ambiguous timeouts; changing generation, configuration, or lease does not erase billed attempts or their original budget window.
6. Initial model-quality candidate is explicit `gemini-3.5-flash`; compare Flash-Lite in Task 12. Unknown/unavailable model configuration fails with an actionable status. No silent provider/model/location substitution.
7. Route purchase-invoice intake attempts through the new provider. Keep raw attempt output immutable, show missing/low-confidence facts in review, and record only status/IDs/counts in Inngest outputs. Do not log document bodies, sender addresses, source excerpts, or prompts containing evidence.
8. Add a five-minute reconciliation function for queued work, expired leases, attachment copy retries, and failed event dispatch. Retry only transient transport/429/5xx failures with bounded backoff; parsing/schema/unsupported-document errors return to review. Pause and authorization loss stop new calls without removing data.

**Verify:**
```bash
corepack pnpm --filter @carbon/jobs exec vitest run src/invoice-intake/provider.test.ts src/invoice-intake/worker.test.ts
# Expected: fake scanned/native documents produce schema-valid review data; token refresh,
# malformed/truncated output, 429/timeouts, three-attempt ceiling, concurrent budgets,
# expired leases, late results with usage, midnight admission, failed matching after extraction,
# pause, and lost event dispatch all pass without live AI calls.
```

**Out of scope:** custom model training, a dedicated model VM, automatic tools/grounding, or a second OCR processor.

## Task 6: Implement deterministic recognition and correction memory

**Depends on:** Tasks 3 and 4
**Files:**
- Create: `packages/jobs/src/invoice-intake/recognition.ts`, `recognition.test.ts`.
- Modify: `apps/erp/app/modules/items/items.service.ts`, `items.server.ts`.
- Modify: `apps/erp/app/modules/invoicing/invoicing.server.ts`, `invoicing.service.ts`.
- Create: `apps/erp/app/modules/invoicing/invoice-intake.recognition.test.ts`.
- Copy from (precedent): `resolveItemIdFromExtractedText`, `supplierPart` models, `mercuryRecipientMapping`.

**Steps:**
1. Implement batched `resolveInvoiceCandidates(client, companyId, supplier, lines)` returning exact matches, ranked suggestions, conflicts, and reasons. Query sets of SKUs/items once per page; do not loop over Supabase lookups.
2. Precedence: confirmed recipient/supplier alias, confirmed supplier SKU+pack, confirmed supplier description/manufacturer alias, exact catalog match, model suggestions. Trim/casefold conservatively, escape wildcard text, preserve dimensions/revisions/pack units and refuse ambiguous matches.
3. Use existing actual item.type when resolving a line. Group identical new-item proposals within an intake. Match key contains normalized evidence/specification/unit data, not tenant-specific IDs, so restore can preserve it.
4. `persistInvoiceRecognition(trx, actor, decisions)` runs only inside successful approval. Save supplier SKU/UoM conversions through Supplier Part and narrow aliases in the new rule table. Do not update catalog cost, default price, or prior financial fields.
5. Conflicting SKU/alias changes require explicit replacement intent and reason; deactivate/supersede a rule instead of losing history. Correcting one supplier must not affect another supplier/company.
6. Expose read, disable, and replace operations under existing invoicing plus affected supplier/item update permissions. Revalidate target item activity/release and units before reusing a rule. Semantic search can be a suggestion experiment after the deterministic path passes; it is not needed for initial readiness.

**Verify:**
```bash
corepack pnpm --filter @carbon/jobs exec vitest run src/invoice-intake/recognition.test.ts
corepack pnpm --dir apps/erp exec vitest run app/modules/invoicing/invoice-intake.recognition.test.ts
# Expected: approve once recognizes next invoice; changed price remains new evidence; changed pack,
# grade/dimension/revision, wildcard SKU, duplicate SKU, and cross-company aliases cannot auto-match.
```

**Out of scope:** rewriting the global search system or changing existing item classes automatically.

## Task 7: Implement atomic supplier/item/invoice approval

**Depends on:** Tasks 3, 4 and 6
**Files:**
- Modify: `apps/erp/app/modules/invoicing/invoicing.server.ts`, `invoicing.service.ts`, `mercury.server.ts`.
- Modify: `apps/erp/app/modules/items/items.server.ts`, `items.service.ts`.
- Create: `apps/erp/app/modules/purchasing/purchasing.server.ts`.
- Modify: `apps/erp/app/modules/purchasing/purchasing.service.ts`.
- Modify: `packages/database/src/mercury.ts`, `packages/database/src/audit.config.ts`.
- Create: `apps/erp/app/modules/invoicing/invoice-intake.integration.test.ts`.
- Copy from (precedent): `approveMercuryImport`, native item subtype writers, normal invoice defaults.

**Steps:**
1. Add transaction-compatible `createReviewedSupplier(trx, actor, input)`, `createReviewedItem(trx, actor, typedInput)`, and `createReviewedPurchaseInvoice(trx, actor, input)`. Share pure payload/default preparation with real existing callers. Do not call the current Supabase `upsert*` functions and pretend they join a transaction.
2. Preserve supplier interceptors, payment/shipping/tax defaults, org relationships, IDs/sequences, itemCost defaults, and subtype linkage (`material.id = item.readableId`). Preserve class-specific fields and required custom fields. Tests compare creation results with normal forms' contracts.
3. Implement `approveInvoiceIntake(db, actor, {intakeId,expectedRevision,approvalKey,decisions})`. Verify invoice/supplier/item-class permissions before opening the transaction, then revalidate current company memberships and selected tenant/group references inside it. Acquire one shared per-company invoice-approval advisory lock FIRST in both this function and the existing `approveMercuryImport` path, before either takes any row lock. Within it, lock sorted Mercury imports, intake, sorted recognition/recipient identities, duplicate identity, and linked Draft. The modest company-level serialization prevents an old-Mercury/intake lock-order deadlock; provider/storage calls are outside it.
4. New invoice: create interaction/header/delivery and ordered native lines once. Empty existing Draft: fill it. Edited/populated Draft: apply only explicitly reviewed per-line mappings and expected invoice/line revisions; preserve manually authored lines. Non-Draft: evidence link only.
5. Validate currency and the actual FX/date requirements before commit; do not default a foreign-currency historical invoice to rate 1 or silently replace its supplied rate with today's rate. Preserve normal invoice conventions and expose an unresolved rate as a review issue.
6. Persist master creations, invoice lines, learned mappings, Mercury links, approval snapshot/audit and status atomically. Same approval key returns the original result; different stale decisions fail without side effects. Created/selected item type is authoritative; remove the hardcoded Part assumption through the existing extracted-line entrypoints in Task 8.
7. Register new intake/rule audit roots through existing audit conventions. Start deterministic source-file association/copy after commit with durable status and retries. Any copy uses protected `companyId/invoice-intake/intakeId/invoice/invoiceId/hash-name`; invoice source viewing resolves this protected association instead of weakening access by copying into an unrestricted folder. Neither a storage failure nor an Inngest failure replays invoice creation.

**Verify:**
```bash
corepack pnpm --dir apps/erp exec vitest run app/modules/invoicing/invoice-intake.integration.test.ts
# Expected: dedicated localhost-only suite runs (not skips); repeated/concurrent approval,
# old-Mercury versus intake approval race, rollback mid-creation, typed subtype parity, supplier policy, two partial payments,
# stale edited Draft, posted invoice, and attachment failure pass. Assert ZERO new
# itemLedger, costLedger, receipt, journal, payment, and settlement rows from approval.
```

**Out of scope:** automatically approving suppliers against policy, posting invoices, stock migration, payment initiation or settlement.

## Task 8: Build document inbox and typed review UI

**Depends on:** Tasks 4–7
**Files:**
- Create: `apps/erp/app/routes/x+/invoicing+/documents.tsx`, `documents.$intakeId.tsx`.
- Create: `apps/erp/app/modules/invoicing/ui/InvoiceDocuments/InvoiceDocumentInbox.tsx`, `InvoiceDocumentReview.tsx`, `InvoiceDocumentLines.tsx`, `InvoiceRecognitionRules.tsx`.
- Create: `apps/erp/app/modules/items/items.creation.integration.test.ts`.
- Modify: `apps/erp/app/modules/invoicing/ui/PurchaseInvoice/PurchaseInvoiceForm.tsx`, `usePurchaseInvoiceAutoFill.ts`, `MapExtractedInvoiceLinesModal.tsx`, `PurchaseInvoiceExplorer.tsx`.
- Modify: `apps/erp/app/routes/x+/purchase-invoice+/new.tsx`, `apps/erp/app/routes/api+/purchase-invoice.$invoiceId.map-lines.ts`.
- Modify: `apps/erp/app/components/Form/PdfExtractor.tsx`, `Supplier.tsx`, `Item.tsx`, `apps/erp/app/utils/path.ts`, `apps/erp/app/modules/invoicing/index.ts`.
- Copy from (precedent): `MapExtractedLinesModal.tsx`, normal `PurchaseInvoiceLineForm.tsx`, Mercury review route, existing typed supplier/item forms.

**Steps:**
1. Add Documents navigation in the invoicing module's existing navigation definition. Use path helpers and existing table/filter components; show all spec states, sources, totals, issues, and proposed new entity counts.
2. Build side-by-side source/review with source page links, editable field provenance, supplier selection/create and full typed line forms. Refactor form field bodies for a proposal-only mode rather than triggering each modal's immediate create action. Cancel/save cannot leave orphan master records.
3. Expose explicit price/quantity/UoM correction, repeated-item grouping, optional remember-match controls, duplicate link/merge, and visible charge allocation. Do not hide unknowns as Comment lines that can silently pass approval.
4. Reuse this review from new invoice PDF upload, the unmatched-lines banner, and Mercury documents. Existing matched lines keep their actual native type. Preserve RFQ extraction's component props and request contract.
5. Show the effect of Approve: new supplier/item counts and Draft destination. Linked/posting status and historical reminders are visible. Ready documents support multi-select approval with per-document success/conflict results; ambiguous rows require review.
6. Add inference pause/budget/backfill status and rule correction surfaces under existing settings/update permissions. Use Lingui, existing form/number/date controls, accessible labels, and optimistic revision checks.

**Verify:**
```bash
corepack pnpm --dir apps/erp exec vitest run app/modules/items/items.creation.integration.test.ts
corepack pnpm exec turbo run typecheck --filter=erp
# Expected: actual type forms render, unknown/ambiguous values remain editable, blocked approvals
# explain the issue, stale edits display conflicts, and scoped typecheck passes.
```

**Out of scope:** a new generic form framework, MES UI, or root navigation redesign.

## Task 9: Connect Mercury/Gmail and resume historical documents

**Depends on:** Tasks 4–8
**Files:**
- Modify: `packages/jobs/src/payment-sync/sync.ts`, `providers.ts`, existing sync tests.
- Create: `packages/jobs/src/invoice-intake/backfill.ts`, `backfill.test.ts`.
- Create: `packages/jobs/src/inngest/functions/extraction/invoice-intake-backfill.ts`.
- Modify: `packages/lib/src/events.ts`, `packages/lib/src/trigger.ts`, `packages/jobs/src/inngest/index.ts`.
- Modify: `apps/erp/app/routes/x+/invoicing+/mercury.tsx`, `apps/erp/app/modules/invoicing/mercury.server.ts`.
- Modify: `contrib/deploying/gcp-tailscale/PAYMENT-SYNC.md`.

**Steps:**
1. At successful committed Mercury page completion, register each verified document via the same source service. Do not make bank syncing wait on inference. Recover missed ingestion from a paginated reconciliation pass.
2. Start historical document ingestion explicitly from the UI. Freeze an upper timestamp, page by `(createdAt,id)` in groups of 100 with a persisted cursor, and update cursor/counts only after source registration commits. Rerunning uses source identities and is harmless.
3. Implement every row of the spec's historical-state matrix. Fill an existing empty Draft only on approval; never feed a linked invoice through the old helper and assume its early-return path populates lines.
4. Add explicit Find supporting document again for approved rows with missing evidence, using current readonly clients, enabled mailboxes and bounded searches. Keep existing hourly sync and mailbox pause semantics unchanged.
5. Represent multiple payments/evidence sources as relationships to one intake/invoice. Protect conflicting existing links. Never fabricate item lines or missing invoice totals from bank amounts.

**Verify:**
```bash
corepack pnpm --filter @carbon/jobs exec vitest run src/invoice-intake/backfill.test.ts src/payment-sync/sync.test.ts src/payment-sync/providers.test.ts
corepack pnpm --dir apps/erp exec vitest run app/modules/invoicing/mercury.test.ts app/modules/invoicing/invoice-intake.integration.test.ts
# Expected: interrupted backfill resumes, all historical status combinations preserve links,
# paused mailboxes stay untouched, and payment sync succeeds even when inference is unavailable.
```

**Out of scope:** changing bank transaction scope, adding mailbox accounts, sending/marking/deleting email.

## Task 10: Verify backups, restore paths, and existing-flow compatibility

**Depends on:** Tasks 2 and 9
**Files:**
- Modify: `packages/jobs/src/inngest/functions/tasks/company-backup.ts`, `company-backup.transforms.ts`, `company-backup.closure.test.ts`.
- Create: `packages/jobs/src/inngest/functions/tasks/company-backup.invoice-intake.test.ts`.
- Extend: intake SQL/integration tests with restored-company cases.
- Copy from (precedent): current FK closure and thumbnail path transformation tests.

**Steps:**
1. Ensure new company-scoped tables enter backup closure and selected supplier/item/invoice/PO/asset FKs remap. Do not add mappings declaring native tables dropped.
2. Add typed transforms for intake source storage paths, documentExtraction paths, and existing Mercury attachment JSON paths. Rewrite only a validated source-company prefix, not arbitrary evidence strings.
3. Preserve raw evidence/model output as historical facts; clear/revalidate transient candidate IDs and unfinished creation proposals on foreign-company restore. Reset active leases and backfill cursor, set unresolved restored reviews to NeedsReview, and prevent old queued events from running under a new company.
4. Verify saved Supplier Part and approved alias mappings remain correct, and source contents are recoverable without a model call. Keep inference secrets in deployment secret handling, outside portable company exports.
5. Confirm the existing full infrastructure backup still covers database and Supabase file volumes. No new storage service should be introduced solely for inference.

**Verify:**
```bash
corepack pnpm --filter @carbon/jobs exec vitest run src/inngest/functions/tasks/company-backup.closure.test.ts src/inngest/functions/tasks/company-backup.invoice-intake.test.ts
corepack pnpm db:check:datasets
corepack pnpm db:check:backups
# Expected: same-company and foreign-company restore preserve evidence/canonical mappings,
# no stale tenant path or authoritative JSON ID is accepted, and compatibility gates pass.
```

**Out of scope:** changing existing cold-backup retention or restoring over the live database.

## Task 11: Add repeatable laptop deployment configuration

**Depends on:** Task 5 configuration contract
**Files:**
- Create: `contrib/deploying/gcp-tailscale/invoice_inference.py`, `test_invoice_inference.py`, `INVOICE-DOCUMENTS.md`.
- Modify: `contrib/deploying/gcp-tailscale/deploy.py`, `render.py`, `config.example.json`, `test_render.py`, `test_deploy.py`.
- Copy from (precedent): `payment_sync.py`, optional backup setup integration, file permission handling.

**Steps:**
1. Add optional ignored inference config with project/location/model/pricing/limits; tracked examples are synthetic. Report missing configuration without exposing values or credentials. Inference defaults off; manual document review and core ERP remain usable.
2. Enable the required API and idempotently provision a dedicated service account/custom role with `aiplatform.endpoints.predict`. Attach it to the Compute VM with cloud-platform scope using the existing deployment lifecycle; do not add storage, secrets, or project-admin roles. Explain the VM-wide identity boundary in operator documentation.
3. Pass server-only inference config to ERP/job execution. Metadata tokens need no secret JSON key. Verify the configured model/US endpoint with a synthetic request only once enabled; do not claim model availability from a successful ERP health response.
4. Preserve NAT/TLS outbound access, private inbound/Tailscale restrictions, and existing auth. No global provider fallback or public evidence URL.
5. Expose per-company inference/automatic-intake pause and budget controls through settings; pricing/model/project stays operator configuration. Document update/rollback of a model and pausing without redeploying.
6. `make deploy` remains the single recurring deployment command. No new root Makefile target is needed. Deployment must not automatically backfill every document or enable billable inference before initial setup is complete.

**Verify:**
```bash
python3 -m unittest discover -s contrib/deploying/gcp-tailscale -p 'test_invoice_inference.py'
python3 -m unittest discover -s contrib/deploying/gcp-tailscale -p 'test_render.py'
python3 -m unittest discover -s contrib/deploying/gcp-tailscale -p 'test_deploy.py'
# Expected: absent config preserves ordinary deployment; configured rendering contains no keys,
# IAM is narrowly scoped/idempotent, no public ingress is added, and repeat deploy is stable.
```

**Out of scope:** changing DNS/Tailscale enrollment or creating a permanent GPU service.

## Task 12: Evaluate extraction quality and verify the complete workflow

**Depends on:** Tasks 1–11
**Files:**
- Create: `packages/jobs/src/invoice-intake/evaluation.ts`, `evaluation.test.ts`.
- Create: `packages/jobs/src/scripts/evaluate-invoice-intake.ts`.
- Create: synthetic fixture metadata under `packages/jobs/src/invoice-intake/fixtures/`.
- Create: run evidence under ignored `contrib/deploying/gcp-tailscale/.local/invoice-evaluation/`.
- Update: spec acceptance checklist and this plan only when the corresponding checks pass.

**Steps:**
1. Build a 30-document synthetic fixture set with text PDFs, scanned pages, photographed receipts, multi-page tables, tax-inclusive/exclusive prices, discounts/freight, receipts without references, pack units, duplicate scans, and credit/statement exceptions. Include repeat suppliers/SKUs and changed price/quantity variants. Public fixtures contain no real organization data.
2. Add an offline local evaluator using `INVOICE_EVAL_INPUT_DIR` and `INVOICE_EVAL_OUTPUT_DIR` from ignored configuration. Live evaluation runs on the deployed VM through the same budgeted worker/normal intake route, reached over existing Tailscale/IAP access; the laptop cannot call the metadata-authenticated provider directly. The local evaluator scores exported private attempt results without making provider calls. Each live sample therefore has a normal admitted/budgeted attempt and operator identity. Private labels and reports never enter source control or tool logs.
3. Compare Flash and Flash-Lite on the same labeled corpus. Release requirements: every expected line is represented or flagged incomplete; no silent wrong-ready document; all deterministic numeric/permission/duplicate fixtures pass; at least 95% exact accuracy for present date/currency/quantity/unit-price/total fields in the labeled evaluation, with failures visible. These are release targets, not claims of current accuracy.
4. For a separate held-out repeat-purchase set, require correct supplier/item/UoM preselection for all unambiguous approved SKU mappings. Explicitly measure unexpected Ready cases, missing lines, item-type suggestions, correction rate, latency, and actual token cost. Do not use model self-confidence as the evaluation metric.
5. If accuracy fails, keep inference in review-only mode and improve the adapter/prompt or choose the higher-quality configured model. Introduce Document AI or self-hosted OCR only through a documented plan revision based on measured failure cases.
6. Run integration and regression checks below, then browser-verify via the repository test skill in an authorized local/test session. Exercise new supplier and every item class, repeated purchase, invalid pack, edited Draft, already-posted invoice, no document, pause/retry/budget, simultaneous approval, and private evidence access. Confirm no stock/payment/GL side effects.

**Verify:**
```bash
corepack pnpm --filter @carbon/jobs exec vitest run src/invoice-intake src/payment-sync
corepack pnpm --dir apps/erp exec vitest run app/modules/invoicing/invoice-intake.integration.test.ts app/modules/invoicing/invoice-intake.models.test.ts app/modules/items/items.creation.integration.test.ts
corepack pnpm exec turbo run typecheck --filter=erp --filter=@carbon/jobs --filter=@carbon/database
corepack pnpm --filter @carbon/jobs exec tsx src/scripts/evaluate-invoice-intake.ts
# Expected: scoped checks pass with the required DB suite actually executed; offline evaluation
# succeeds; live evaluation and browser receipts are recorded separately before marking ACs complete.
```

**Out of scope:** silently uploading private samples to an unconfigured provider, tuning a custom model, or declaring extraction accurate from mocked tests.

## Task 13: Integrate upstream, deploy, and enable a measured historical run

**Depends on:** Task 12; implementation/deployment authorization
**Files:**
- Update: nested operator guide, spec/plan checklists.
- Runtime receipts: ignored deployment/evaluation directories only.
- Copy from (precedent): `contrib/deploying/gcp-tailscale/WORKFLOW.md` and `fork.sh`.

**Steps:**
1. Review source diff for real documents, credentials, organization-specific configuration, unwanted root changes, and unused abstraction. Run the repository pre-commit gates and retain validation evidence. Do not bypass a failed schema/backup gate to merge.
2. Follow the existing fork workflow: finish the feature branch, merge into `saturn/main`, merge/rebase latest `upstream/main`, resolve conflicts, and rerun affected scoped checks. Deploy only clean `saturn/main`; do not deploy the feature branch or an unpublished arbitrary commit.
3. Run `make deploy`. Confirm ERP/MES/Supabase/event readiness and verify Kanban's existing health still passes. Verify database/storage backups remain enabled. Use a synthetic document to confirm deployed inference, review, draft creation and source viewing.
4. Enable inference for the configured company, review a small real-document sample, and explicitly start historical document ingestion. Show counts/cursor/budget/failed rows. Maintain hourly Mercury sync independently; no laptop process must remain running.
5. Verify a duplicate upload/source replay and one repeated supplier SKU after deployment. Capture private run receipts without printing document content or source URLs with credentials.
6. Rollback: pause new inference/backfill, retain all evidence and existing drafts, and roll forward a fix or deploy the known compatible previous application. Additive tables remain; never undo posted records or delete approved masters. Do not deploy an older app against changed extraction policies without a reviewed compatibility patch.

**Verify:**
```bash
git diff --check
git status --short --branch
make deploy
# Expected at deployment time: clean saturn/main, successful private readiness checks and exact
# deployed revision; explicit synthetic end-to-end receipt; historical progress resumes server-side.
```

**Out of scope:** automatic posting/receiving/settlement or minimizing downtime through a separate migration project. Deployment is authorized by the execution request.

## Acceptance coverage

| Spec criteria | Tasks |
|---|---|
| AC1 extraction/input formats | 3, 4, 5, 8, 12 |
| AC2 typed master creation | 6, 7, 8, 12 |
| AC3 correction memory | 6, 7, 12 |
| AC4 revisions and safe retries | 3, 5, 7, 12 |
| AC5 duplicate prevention | 4, 7, 9, 12 |
| AC6 numeric/type/FX exceptions | 3, 7, 8, 12 |
| AC7 no accounting/stock side effects | 7, 9, 12 |
| AC8 historical migration | 9, 13 |
| AC9 access controls | 1, 4, 7, 12 |
| AC10 bounded execution/budget | 5, 8, 11, 12 |
| AC11 backup/restore | 2, 10, 13 |
| AC12 upstream/manual/RFQ compatibility | 4, 7, 8, 10, 12 |
| AC13 repeatable private deployment | 11, 13 |
| AC14 evaluation/versioning/rollback | 5, 11, 12, 13 |

## Planning verification

Before handing off this document, verify all existing referenced files, relative artifact links, checklist/acceptance coverage, absence of unresolved placeholders, and `git diff --check`. Runtime tests belong to the implementation tasks above and must not be reported as having run during planning.

## Execution evidence

- Task 1: committed `793ca7933`; additive migrations and nine grouped PostgreSQL/TAP cases pass. Canonical types regenerated, database package typecheck and workflow catalog checks pass. All four dataset checks and backup compatibility pass, including the pre-commit gates.
- Validation uses a new isolated local PostgreSQL instance restored from the retained schema-only archive whose migration ledger matches the tracked migrations. No existing local or deployed database was reset. Runtime credentials are in ignored deployment configuration.
- Proposal mode is a small optional callback on the six existing supplier/item forms. It captures validated values and custom fields without submitting their native create actions; CAD upload is hidden in this mode.
- Tasks 4/9 jobs: source registration, historical pages and Mercury integration pass real PostgreSQL tests for concurrent deduplication, owned paths, explicit tenant grants, immutable invoice links, partial registration recovery, frozen history windows and mailbox pause controls. Bank-page commits precede local intake registration; model dispatch remains independent.
- Task 10: typed foreign-restore transforms preserve canonical invoice/supplier/item references and original evidence, remap private file paths, clear proposals and leases, and disable connected processing. Unit tests and an actual migrated PostgreSQL source-to-target restore test pass without disabling foreign keys. Infrastructure backup tests pass; the retained-disk snapshot still includes the new tables and private Supabase uploads.

- Task 2 / access follow-up: committed `a7456eab9`; canonical generated types and protected financial document metadata policies pass 14 total SQL cases. Pre-commit dataset and backup gates pass. The hook also generated the source catalogs; target-language filling follows UI stabilization.
- Tasks 3/6: 14 review/numeric/state tests and 7 recognition tests pass, including missing values, native tax-pair edits, preserved raw matching identities, and pack changes. Recognition indexes use SHA-256 of complete normalized identities to support long Unicode descriptions without PostgreSQL index-size failures; original identities remain readable in evidence/rule history.
- Proposal selectors defer nested master creation. Existing taxonomy, units, bins and supplier types are selectable; missing definitions are created explicitly through their native module after saving the review, then selected when the proposal is reopened. Proposal cancellation and review saving cannot create these records accidentally.

- Final local verification: 139 job/source/backfill/provider/backup tests pass, including actual PostgreSQL cases. Seventeen atomic approval/native-creation database tests pass, plus fourteen pure review tests and eight recognition tests. ERP production build and ERP/database/jobs/env/lib/MES typechecks pass. The conformance gate reports only the two unchanged payment-sync/providers.ts rounding violations already present on saturn/main.
- Browser verification used a new isolated local stack and synthetic records: private upload/preview, all five native item proposal forms, cancel/save without early masters, Consumable and generated Material approval into native Draft invoices, correct source links, and unchanged inventory ledger. A discovered generated-material validator stripping bug was fixed in proposal mode and verified through real approval.
- Additional review fixes cover exact source identity memory, conflicting remembered pack targets, tagged custom fields on native subtype records, saving incomplete invoice references, permission-aware recognition controls, attachment-copy status, stable PDF previews through polling, historical reminders, and post-approval selected labels.
