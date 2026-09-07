-- Financial document metadata follows its protected object namespace. A native
-- document row must not expose a filename or invoice identity through broad
-- document permissions, even when the underlying bytes are already restricted.
CREATE POLICY "invoice_financial_document_read" ON public."document"
AS RESTRICTIVE FOR SELECT TO authenticated USING (
  split_part(path, '/', 2) NOT IN ('invoice-intake', 'mercury') OR (
    split_part(path, '/', 1) = "companyId" AND
    "companyId" = ANY ((SELECT get_companies_with_employee_permission('invoicing_view'))::text[])
  )
);

-- Copied invoice evidence has no generic document sharing groups. Invoicing
-- permission itself is the positive grant; the restrictive policy above also
-- constrains any other permissive policy introduced later.
CREATE POLICY "invoice_financial_document_view" ON public."document"
FOR SELECT TO authenticated USING (
  split_part(path, '/', 2) IN ('invoice-intake', 'mercury') AND
  split_part(path, '/', 1) = "companyId" AND
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('invoicing_view'))::text[])
);

-- Attachment association is service-owned after the invoice transaction. Direct
-- clients cannot relabel or delete that association through the document API.
CREATE POLICY "invoice_financial_document_insert" ON public."document"
AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (split_part(path, '/', 2) NOT IN ('invoice-intake', 'mercury'));
CREATE POLICY "invoice_financial_document_update" ON public."document"
AS RESTRICTIVE FOR UPDATE TO authenticated
USING (split_part(path, '/', 2) NOT IN ('invoice-intake', 'mercury'))
WITH CHECK (split_part(path, '/', 2) NOT IN ('invoice-intake', 'mercury'));
CREATE POLICY "invoice_financial_document_delete" ON public."document"
AS RESTRICTIVE FOR DELETE TO authenticated
USING (split_part(path, '/', 2) NOT IN ('invoice-intake', 'mercury'));

NOTIFY pgrst, 'reload schema';
