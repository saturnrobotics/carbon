-- Durable company-scoped invoice document review and extraction attempts.
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
  "dailyBudgetUsd" numeric NOT NULL DEFAULT 5 CHECK ("dailyBudgetUsd" >= 0 AND "dailyBudgetUsd" < 'Infinity'::numeric),
  "monthlyBudgetUsd" numeric NOT NULL DEFAULT 50 CHECK ("monthlyBudgetUsd" >= 0 AND "monthlyBudgetUsd" < 'Infinity'::numeric),
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
  CHECK ("storagePath" IS NULL OR ("storageBucket" = 'private'
    AND split_part("storagePath", '/', 1) = "companyId"
    AND "storagePath" !~ '(^|/)\\.\\.?(/|$)'
    AND "storagePath" !~ '[[:cntrl:]\\\\]')),
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

GRANT SELECT ON public."invoiceIntakeSettings", public."invoiceIntake",
  public."invoiceIntakeSource", public."invoiceIntakeLine", public."invoiceRecognitionRule"
  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."invoiceIntakeSettings", public."invoiceIntake",
  public."invoiceIntakeSource", public."invoiceIntakeLine", public."invoiceRecognitionRule"
  TO service_role;

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
CREATE POLICY "invoice_intake_authorized_read" ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'private' AND split_part(name,'/',2) = 'invoice-intake' AND
  split_part(name,'/',1) = ANY ((SELECT get_companies_with_employee_permission('invoicing_view'))::text[])
);
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

NOTIFY pgrst, 'reload schema';
