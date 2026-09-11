-- knowledgeCommandReceipt was created (20260908004744) with has_role() /
-- has_company_permission() policies, the pattern deprecated by
-- 20260817030612_remove-global-permission-wildcard. Move it to the current
-- get_companies_with_employee_permission() form used by every later table.
DROP POLICY IF EXISTS "Employees with purchasing view can view knowledge command receipts" ON public."knowledgeCommandReceipt";
DROP POLICY IF EXISTS "Employees with purchasing create can create knowledge command receipts" ON public."knowledgeCommandReceipt";

CREATE POLICY "SELECT" ON public."knowledgeCommandReceipt"
  FOR SELECT USING (
    "companyId" = ANY ((SELECT public.get_companies_with_employee_permission('purchasing_view'))::text[])
  );
CREATE POLICY "INSERT" ON public."knowledgeCommandReceipt"
  FOR INSERT WITH CHECK (
    "companyId" = ANY ((SELECT public.get_companies_with_employee_permission('purchasing_create'))::text[])
  );
