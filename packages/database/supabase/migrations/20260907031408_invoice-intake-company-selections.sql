-- Payment terms and cost centers are company scoped in the current catalog.
-- Keep these selected references tenant-safe even in privileged transactions.
CREATE UNIQUE INDEX IF NOT EXISTS "paymentTerm_invoice_intake_tenant_key"
  ON public."paymentTerm" ("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "costCenter_invoice_intake_tenant_key"
  ON public."costCenter" ("id", "companyId");

ALTER TABLE public."invoiceIntake"
  ADD CONSTRAINT "invoiceIntake_paymentTerm_company_fkey"
  FOREIGN KEY ("paymentTermId", "companyId")
  REFERENCES public."paymentTerm" ("id", "companyId");
ALTER TABLE public."invoiceIntakeLine"
  ADD CONSTRAINT "invoiceIntakeLine_costCenter_company_fkey"
  FOREIGN KEY ("costCenterId", "companyId")
  REFERENCES public."costCenter" ("id", "companyId");

NOTIFY pgrst, 'reload schema';
