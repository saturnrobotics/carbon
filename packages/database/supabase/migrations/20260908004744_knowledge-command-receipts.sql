CREATE TABLE IF NOT EXISTS public."knowledgeCommandReceipt" (
  id text PRIMARY KEY DEFAULT public.id('kcmd'),
  "companyId" text NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
  "actorId" text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  action text NOT NULL,
  "idempotencyKey" text NOT NULL,
  "payloadHash" text NOT NULL CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  "purchaseOrderId" text NOT NULL REFERENCES public."purchaseOrder"(id) ON DELETE RESTRICT,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("companyId", "actorId", action, "idempotencyKey")
);
CREATE INDEX IF NOT EXISTS knowledge_command_receipt_purchase_order_idx ON public."knowledgeCommandReceipt"("purchaseOrderId");
ALTER TABLE public."knowledgeCommandReceipt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Employees with purchasing view can view knowledge command receipts" ON public."knowledgeCommandReceipt"
  FOR SELECT USING (public.has_role('employee', "companyId") AND public.has_company_permission('purchasing_view', "companyId"));
CREATE POLICY "Employees with purchasing create can create knowledge command receipts" ON public."knowledgeCommandReceipt"
  FOR INSERT WITH CHECK (public.has_role('employee', "companyId") AND public.has_company_permission('purchasing_create', "companyId"));
