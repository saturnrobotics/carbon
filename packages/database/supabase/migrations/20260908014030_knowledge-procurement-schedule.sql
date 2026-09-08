-- A scheduled knowledge command holds its validated proposal and actor reference,
-- never a workforce/IAP credential.  The jobs worker rechecks the actor's current
-- membership and purchasing_create permission before dispatching the canonical
-- Draft-PO operation.
CREATE TABLE public."knowledgeProcurementSchedule" (
  id text NOT NULL DEFAULT public.id('kps'),
  "companyId" text NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
  "companyGroupId" text NOT NULL,
  "actorId" text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action = 'carbon.procurement.draft'),
  version bigint NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  "payloadHash" text NOT NULL CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  "idempotencyKey" text NOT NULL,
  "executeAt" timestamptz NOT NULL,
  "claimedAt" timestamptz,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'succeeded', 'failed', 'cancelled')),
  "revocationCheckedAt" timestamptz,
  "revocationVersion" text,
  "purchaseOrderId" text REFERENCES public."purchaseOrder"(id) ON DELETE RESTRICT,
  "failureCode" text,
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  PRIMARY KEY (id, "companyId"),
  UNIQUE ("companyId", "actorId", action, "idempotencyKey")
);

CREATE INDEX knowledge_procurement_schedule_due_idx
  ON public."knowledgeProcurementSchedule" ("executeAt")
  WHERE status = 'scheduled';
CREATE INDEX knowledge_procurement_schedule_company_idx
  ON public."knowledgeProcurementSchedule" ("companyId");
CREATE INDEX knowledge_procurement_schedule_actor_idx
  ON public."knowledgeProcurementSchedule" ("actorId");
CREATE INDEX knowledge_procurement_schedule_purchase_order_idx
  ON public."knowledgeProcurementSchedule" ("purchaseOrderId");

ALTER TABLE public."knowledgeProcurementSchedule" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SELECT" ON public."knowledgeProcurementSchedule"
  FOR SELECT USING (
    "companyId" = ANY ((SELECT public.get_companies_with_employee_permission('purchasing_view'))::text[])
  );
CREATE POLICY "INSERT" ON public."knowledgeProcurementSchedule"
  FOR INSERT WITH CHECK (
    "companyId" = ANY ((SELECT public.get_companies_with_employee_permission('purchasing_create'))::text[])
  );
CREATE POLICY "UPDATE" ON public."knowledgeProcurementSchedule"
  FOR UPDATE USING (
    "companyId" = ANY ((SELECT public.get_companies_with_employee_permission('purchasing_create'))::text[])
  );
CREATE POLICY "DELETE" ON public."knowledgeProcurementSchedule"
  FOR DELETE USING (
    "companyId" = ANY ((SELECT public.get_companies_with_employee_permission('purchasing_delete'))::text[])
  );
