-- Keep import links inside their owning company even for privileged workers.
CREATE UNIQUE INDEX IF NOT EXISTS "purchaseInvoice_id_companyId_key"
  ON "public"."purchaseInvoice" ("id", "companyId");

CREATE TABLE "public"."mercurySyncSettings" (
  "id" TEXT NOT NULL DEFAULT id('mss'),
  "companyId" TEXT NOT NULL REFERENCES "public"."company"("id") ON DELETE CASCADE,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "gmailEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "disabledMailboxes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "syncFromDate" DATE,
  "cursor" TEXT,
  "eventCursor" TEXT,
  "lastAttemptAt" TIMESTAMPTZ,
  "lastSuccessAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "lastGmailError" TEXT,
  "createdBy" TEXT NOT NULL REFERENCES "public"."user"("id"),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "public"."user"("id"),
  "updatedAt" TIMESTAMPTZ,
  PRIMARY KEY ("id", "companyId"),
  UNIQUE ("companyId")
);

CREATE TABLE "public"."mercuryRecipientMapping" (
  "id" TEXT NOT NULL DEFAULT id('mrm'),
  "companyId" TEXT NOT NULL REFERENCES "public"."company"("id") ON DELETE CASCADE,
  "mercuryRecipientId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL REFERENCES "public"."user"("id"),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "public"."user"("id"),
  "updatedAt" TIMESTAMPTZ,
  PRIMARY KEY ("id", "companyId"),
  UNIQUE ("companyId", "mercuryRecipientId"),
  FOREIGN KEY ("supplierId", "companyId") REFERENCES "public"."supplier"("id", "companyId") ON DELETE RESTRICT
);

CREATE TABLE "public"."mercuryTransactionImport" (
  "id" TEXT NOT NULL DEFAULT id('mti'),
  "companyId" TEXT NOT NULL REFERENCES "public"."company"("id") ON DELETE CASCADE,
  "mercuryTransactionId" TEXT NOT NULL,
  "mercuryAccountId" TEXT NOT NULL,
  "mercuryRecipientId" TEXT,
  "remoteStatus" TEXT NOT NULL,
  "amount" NUMERIC NOT NULL CHECK ("amount" >= 0 AND "amount" NOT IN ('NaN'::NUMERIC, 'Infinity'::NUMERIC)),
  "currencyCode" TEXT NOT NULL,
  "transactionDate" TEXT NOT NULL,
  "reference" TEXT,
  "memo" TEXT,
  "vendorSuggestion" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "invoiceEvidence" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "attachments" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "reviewStatus" TEXT NOT NULL DEFAULT 'Pending' CHECK ("reviewStatus" IN ('Pending', 'Imported', 'Ignored')),
  "supplierId" TEXT,
  "purchaseInvoiceId" TEXT,
  "lastError" TEXT,
  "createdBy" TEXT NOT NULL REFERENCES "public"."user"("id"),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "public"."user"("id"),
  "updatedAt" TIMESTAMPTZ,
  PRIMARY KEY ("id", "companyId"),
  UNIQUE ("companyId", "mercuryTransactionId"),
  FOREIGN KEY ("supplierId", "companyId") REFERENCES "public"."supplier"("id", "companyId") ON DELETE RESTRICT,
  FOREIGN KEY ("purchaseInvoiceId", "companyId") REFERENCES "public"."purchaseInvoice"("id", "companyId") ON DELETE RESTRICT
);

CREATE INDEX "mercurySyncSettings_createdBy_idx" ON "public"."mercurySyncSettings" ("createdBy");
CREATE INDEX "mercurySyncSettings_updatedBy_idx" ON "public"."mercurySyncSettings" ("updatedBy");
CREATE INDEX "mercuryRecipientMapping_supplierId_idx" ON "public"."mercuryRecipientMapping" ("supplierId");
CREATE INDEX "mercuryRecipientMapping_createdBy_idx" ON "public"."mercuryRecipientMapping" ("createdBy");
CREATE INDEX "mercuryRecipientMapping_updatedBy_idx" ON "public"."mercuryRecipientMapping" ("updatedBy");
CREATE INDEX "mercuryTransactionImport_supplierId_idx" ON "public"."mercuryTransactionImport" ("supplierId");
CREATE INDEX "mercuryTransactionImport_purchaseInvoiceId_idx" ON "public"."mercuryTransactionImport" ("purchaseInvoiceId");
CREATE INDEX "mercuryTransactionImport_createdBy_idx" ON "public"."mercuryTransactionImport" ("createdBy");
CREATE INDEX "mercuryTransactionImport_updatedBy_idx" ON "public"."mercuryTransactionImport" ("updatedBy");
CREATE INDEX "mercuryTransactionImport_review_idx" ON "public"."mercuryTransactionImport" ("companyId", "reviewStatus", "createdAt");

-- These records contain bank and invoice evidence. Reads require invoicing
-- access; settings and vendor mappings have narrower write permissions.
ALTER TABLE "public"."mercurySyncSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."mercuryRecipientMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."mercuryTransactionImport" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SELECT" ON "public"."mercurySyncSettings" FOR SELECT TO authenticated
  USING ("companyId" = ANY ((SELECT get_companies_with_employee_permission('invoicing_view'))::TEXT[]));
CREATE POLICY "INSERT" ON "public"."mercurySyncSettings" FOR INSERT TO authenticated WITH CHECK (FALSE);
CREATE POLICY "UPDATE" ON "public"."mercurySyncSettings" FOR UPDATE TO authenticated USING (FALSE) WITH CHECK (FALSE);
CREATE POLICY "DELETE" ON "public"."mercurySyncSettings" FOR DELETE TO authenticated USING (FALSE);

CREATE POLICY "SELECT" ON "public"."mercuryRecipientMapping" FOR SELECT TO authenticated
  USING ("companyId" = ANY ((SELECT get_companies_with_employee_permission('invoicing_view'))::TEXT[]));
CREATE POLICY "INSERT" ON "public"."mercuryRecipientMapping" FOR INSERT TO authenticated WITH CHECK (FALSE);
CREATE POLICY "UPDATE" ON "public"."mercuryRecipientMapping" FOR UPDATE TO authenticated USING (FALSE) WITH CHECK (FALSE);
CREATE POLICY "DELETE" ON "public"."mercuryRecipientMapping" FOR DELETE TO authenticated USING (FALSE);

CREATE POLICY "SELECT" ON "public"."mercuryTransactionImport" FOR SELECT TO authenticated
  USING ("companyId" = ANY ((SELECT get_companies_with_employee_permission('invoicing_view'))::TEXT[]));
CREATE POLICY "INSERT" ON "public"."mercuryTransactionImport" FOR INSERT TO authenticated WITH CHECK (FALSE);
CREATE POLICY "UPDATE" ON "public"."mercuryTransactionImport" FOR UPDATE TO authenticated USING (FALSE) WITH CHECK (FALSE);
CREATE POLICY "DELETE" ON "public"."mercuryTransactionImport" FOR DELETE TO authenticated USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."mercurySyncSettings", "public"."mercuryRecipientMapping", "public"."mercuryTransactionImport" TO authenticated, service_role;

CREATE POLICY "Mercury evidence read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'private' AND (storage.foldername(name))[2] = 'mercury'
    AND (storage.foldername(name))[1] = ANY ((SELECT get_companies_with_employee_permission('invoicing_view'))::TEXT[]));
CREATE POLICY "Mercury evidence read boundary" ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated
  USING (bucket_id <> 'private' OR (storage.foldername(name))[2] IS DISTINCT FROM 'mercury'
    OR (storage.foldername(name))[1] = ANY ((SELECT get_companies_with_employee_permission('invoicing_view'))::TEXT[]));
CREATE POLICY "Mercury evidence server insert" ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (bucket_id <> 'private' OR (storage.foldername(name))[2] IS DISTINCT FROM 'mercury');
CREATE POLICY "Mercury evidence server update" ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (bucket_id <> 'private' OR (storage.foldername(name))[2] IS DISTINCT FROM 'mercury')
  WITH CHECK (bucket_id <> 'private' OR (storage.foldername(name))[2] IS DISTINCT FROM 'mercury');
CREATE POLICY "Mercury evidence server delete" ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING (bucket_id <> 'private' OR (storage.foldername(name))[2] IS DISTINCT FROM 'mercury');
