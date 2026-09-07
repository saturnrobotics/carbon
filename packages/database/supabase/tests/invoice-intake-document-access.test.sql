BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SET LOCAL "app.sync_in_progress"='true';
SELECT no_plan();

DO $fixtures$
DECLARE actor text:=gen_random_uuid()::text; co_a text; co_b text;
BEGIN
  INSERT INTO public."user"(id,email) VALUES(actor,actor||'@example.com');
  INSERT INTO public.company(name,"baseCurrencyCode") VALUES('Document Access Fixture A','USD') RETURNING id INTO co_a;
  INSERT INTO public.company(name,"baseCurrencyCode") VALUES('Document Access Fixture B','USD') RETURNING id INTO co_b;
  INSERT INTO public."userToCompany"("userId","companyId",role) VALUES(actor,co_a,'employee');
  INSERT INTO public."userPermission"(id,permissions) VALUES(actor,jsonb_build_object('invoicing_view',jsonb_build_array(co_a)))
    ON CONFLICT(id) DO UPDATE SET permissions=EXCLUDED.permissions;
  INSERT INTO public.document(name,type,path,size,"companyId","createdBy","readGroups","writeGroups") VALUES
    ('Synthetic invoice.pdf','PDF',co_a||'/invoice-intake/intake/invoice/invoice/receipt.pdf',12,co_a,actor,'{}','{}'),
    ('Synthetic payment.pdf','PDF',co_a||'/mercury/payment/receipt.pdf',12,co_a,actor,'{}','{}'),
    ('Other company invoice.pdf','PDF',co_b||'/invoice-intake/intake/source/receipt.pdf',12,co_b,actor,'{}','{}'),
    ('Ordinary document.pdf','PDF',co_a||'/documents/ordinary.pdf',12,co_a,actor,'{}','{}');
  PERFORM set_config('request.jwt.claim.sub',actor,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  PERFORM set_config('test.invoice_actor',actor,true);
  PERFORM set_config('test.invoice_company',co_a,true);
END $fixtures$;

SET LOCAL ROLE authenticated;
DO $$ BEGIN ASSERT (SELECT count(*) FROM public.document)=2,'Invoicing viewers require own financial metadata without sharing groups'; END $$;
RESET ROLE;
SELECT pass('Invoicing viewers can read their own financial metadata without document sharing groups');

CREATE POLICY "Intake document test broad" ON public.document FOR ALL TO authenticated USING(true) WITH CHECK(true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN ASSERT (SELECT count(*) FROM public.document WHERE split_part(path,'/',2) IN ('invoice-intake','mercury'))=2,'Broad document policy exposed foreign financial metadata'; END $$;
RESET ROLE;
SELECT pass('Broad document policies cannot expose another company financial metadata');
SET LOCAL ROLE authenticated;
DO $writes$
DECLARE co text:=current_setting('test.invoice_company'); actor text:=current_setting('test.invoice_actor'); changed integer;
BEGIN
  BEGIN
    INSERT INTO public.document(name,type,path,size,"companyId","createdBy") VALUES('Spoofed','PDF',co||'/invoice-intake/spoof.pdf',1,co,actor);
    RAISE EXCEPTION 'Client inserted protected metadata';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.document SET path=co||'/invoice-intake/laundered.pdf' WHERE path=co||'/documents/ordinary.pdf';
    RAISE EXCEPTION 'Client relabeled ordinary metadata as protected';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE public.document SET name='Changed' WHERE path LIKE co||'/invoice-intake/%';
  GET DIAGNOSTICS changed=ROW_COUNT;
  ASSERT changed=0,'Client changed protected metadata';
  DELETE FROM public.document WHERE path LIKE co||'/invoice-intake/%';
  GET DIAGNOSTICS changed=ROW_COUNT;
  ASSERT changed=0,'Client deleted protected metadata';
END $writes$;
RESET ROLE;
SELECT pass('Authenticated protected metadata writes and namespace laundering are denied');

UPDATE public."userPermission" SET permissions='{}'::jsonb WHERE id=current_setting('test.invoice_actor');
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.document WHERE split_part(path,'/',2) IN ('invoice-intake','mercury'))=0,'Employee without invoicing_view read financial metadata';
  ASSERT (SELECT count(*) FROM public.document WHERE "companyId"=current_setting('test.invoice_company') AND split_part(path,'/',2)='documents')=1,'Ordinary document visibility changed';
END $$;
RESET ROLE;
SELECT pass('Employees without invoicing_view cannot read financial metadata; ordinary documents are unaffected');
UPDATE public."userPermission" SET permissions='{"invoicing_view":["0"]}'::jsonb WHERE id=current_setting('test.invoice_actor');
SET LOCAL ROLE authenticated;
DO $$ BEGIN ASSERT (SELECT count(*) FROM public.document WHERE split_part(path,'/',2) IN ('invoice-intake','mercury'))=0,'Obsolete wildcard permission authorized financial metadata'; END $$;
RESET ROLE;
SELECT pass('Obsolete wildcard permission does not authorize financial metadata');
SELECT * FROM finish();
ROLLBACK;
