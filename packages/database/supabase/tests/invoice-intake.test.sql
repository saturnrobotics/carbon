-- Synthetic, rollback-only assertions. Run with `supabase test db` or psql.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL "app.sync_in_progress" = 'true';
SET LOCAL "storage.allow_delete_query" = 'true';
SELECT no_plan();

SELECT has_table('public', name, name || ' exists')
FROM unnest(ARRAY['invoiceIntakeSettings','invoiceIntake','invoiceIntakeSource',
  'invoiceIntakeLine','invoiceRecognitionRule']) AS name;

DO $schema$
DECLARE t text; k record;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoiceIntakeSettings','invoiceIntake','invoiceIntakeSource',
    'invoiceIntakeLine','invoiceRecognitionRule'] LOOP
    ASSERT (SELECT array_agg(a.attname::text ORDER BY c.ordinality)
      FROM pg_constraint p CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY c(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=c.attnum
      WHERE p.conrelid=format('public.%I',t)::regclass AND p.contype='p') = ARRAY['id','companyId'],
      t || ': company-scoped primary key';
    ASSERT (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name=t AND column_name IN ('createdBy','createdAt','updatedBy','updatedAt'))=4,
      t || ': complete audit columns';
    ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid=format('public.%I',t)::regclass),
      t || ': RLS enabled';
    ASSERT (SELECT count(*) FROM pg_policy WHERE polrelid=format('public.%I',t)::regclass
      AND polname IN ('SELECT','INSERT','UPDATE','DELETE'))=4, t || ': all policies exist';
    FOR k IN SELECT DISTINCT a.attnum,a.attname FROM pg_constraint p
      JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=ANY(p.conkey)
      WHERE p.conrelid=format('public.%I',t)::regclass AND p.contype='f' LOOP
      ASSERT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=format('public.%I',t)::regclass
        AND i.indisvalid AND k.attnum=ANY(i.indkey)), t || ': foreign key column is indexed';
    END LOOP;
  END LOOP;
END $schema$;
SELECT pass('All intake tables have composite keys, audit columns, indexes and RLS');

-- A broad future policy must not bypass the financial storage boundary.
CREATE POLICY "Intake test broad storage" ON storage.objects
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DO $fixtures$
DECLARE
  actor text:=gen_random_uuid()::text;
  co_a text:=id(); co_b text:=id();
  supplier_a text; supplier_b text;
  intake_a text; intake_b text; intake_other text;
  extraction_a text; extraction_other text;
  n numeric;
BEGIN
  INSERT INTO public."currencyCode"(code,name) VALUES('USD','US Dollar') ON CONFLICT DO NOTHING;
  INSERT INTO public."user"(id,email) VALUES(actor,actor||'@example.com');
  INSERT INTO public."company"(id,name,"baseCurrencyCode") VALUES
    (co_a,'Invoice Intake Fixture A','USD'),(co_b,'Invoice Intake Fixture B','USD');
  INSERT INTO public."userToCompany"("userId","companyId",role) VALUES(actor,co_a,'employee');
  INSERT INTO public."userPermission"(id,permissions)
    VALUES(actor,jsonb_build_object('invoicing_view',jsonb_build_array(co_a)))
    ON CONFLICT(id) DO UPDATE SET permissions=EXCLUDED.permissions;
  INSERT INTO public."supplier"(name,"readableId","companyId","createdBy")
    VALUES('Fixture Supplier A','INTAKE-A',co_a,actor) RETURNING id INTO supplier_a;
  INSERT INTO public."supplier"(name,"readableId","companyId","createdBy")
    VALUES('Fixture Supplier B','INTAKE-B',co_b,actor) RETURNING id INTO supplier_b;
  INSERT INTO public."invoiceIntakeSettings"("companyId","createdBy") VALUES(co_a,actor),(co_b,actor);
  INSERT INTO public."invoiceIntake"("companyId","supplierId","createdBy")
    VALUES(co_a,supplier_a,actor) RETURNING id INTO intake_a;
  INSERT INTO public."invoiceIntake"("companyId","supplierId","createdBy")
    VALUES(co_b,supplier_b,actor) RETURNING id INTO intake_b;
  INSERT INTO public."invoiceIntake"("companyId","createdBy")
    VALUES(co_a,actor) RETURNING id INTO intake_other;
  INSERT INTO public."invoiceIntakeSource"("companyId","intakeId",kind,"sourceKey","createdBy")
    VALUES(co_a,intake_a,'mercury','payment-only',actor),(co_b,intake_b,'mercury','payment-only',actor);
  INSERT INTO public."invoiceIntakeLine"("companyId","intakeId","lineKey","sortOrder","createdBy")
    VALUES(co_a,intake_a,'1',1,actor),(co_b,intake_b,'1',1,actor);
  INSERT INTO public."invoiceRecognitionRule"("companyId",kind,"matchKey","sourceText","supplierId","createdBy")
    VALUES(co_a,'supplierAlias','example','Example Vendor',supplier_a,actor),
      (co_b,'supplierAlias','example','Example Vendor',supplier_b,actor);
  INSERT INTO public."documentExtraction"("companyId","documentType","sourceDocument","storagePath",
    "intakeId",generation,"inputRevision","attemptNumber",operation,"createdBy")
    VALUES(co_a,'purchaseInvoice','Purchase Invoice',co_a||'/invoice-intake/a.pdf',intake_a,0,0,1,'extract',actor)
    RETURNING id INTO extraction_a;
  INSERT INTO public."documentExtraction"("companyId","documentType","sourceDocument","storagePath",
    "intakeId",generation,"inputRevision","attemptNumber",operation,"createdBy")
    VALUES(co_a,'purchaseInvoice','Purchase Invoice',co_a||'/invoice-intake/b.pdf',intake_other,0,0,1,'extract',actor)
    RETURNING id INTO extraction_other;
  INSERT INTO public."documentExtraction"("companyId","documentType","sourceDocument","storagePath","createdBy")
    VALUES(co_a,'salesRfq','Request for Quote',co_a||'/extractions/rfq.pdf',actor);
  UPDATE public."invoiceIntake" SET "activeExtractionId"=extraction_a WHERE id=intake_a;
  BEGIN
    UPDATE public."invoiceIntake" SET "supplierId"=supplier_b WHERE id=intake_a;
    RAISE EXCEPTION 'Cross-company supplier accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO public."invoiceIntakeLine"("companyId","intakeId","lineKey","sortOrder","createdBy")
      VALUES(co_a,intake_b,'foreign',1,actor);
    RAISE EXCEPTION 'Cross-company intake accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public."invoiceIntake" SET "activeExtractionId"=extraction_other WHERE id=intake_a;
    RAISE EXCEPTION 'Different-intake active attempt accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public."invoiceIntake" SET generation=1 WHERE id=intake_a;
    RAISE EXCEPTION 'Wrong-generation active attempt accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public."documentExtraction" SET "attemptNumber"=NULL WHERE id=extraction_a;
    RAISE EXCEPTION 'Null attempt number accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public."documentExtraction" SET "attemptNumber"=4 WHERE id=extraction_a;
    RAISE EXCEPTION 'Unbounded paid attempt accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public."documentExtraction" SET "documentType"='salesRfq' WHERE id=extraction_a;
    RAISE EXCEPTION 'Financial intake relabeled as RFQ';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public."invoiceIntake" SET status='Approved' WHERE id=intake_a;
    RAISE EXCEPTION 'Approval without invoice/audit accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public."invoiceIntakeSource"("companyId","intakeId",kind,"sourceKey","createdBy")
      VALUES(co_a,intake_a,'mercury','payment-only',actor);
    RAISE EXCEPTION 'Duplicate provider identity accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO public."invoiceIntakeSource"("companyId","intakeId",kind,"sourceKey","storageBucket",
      "storagePath",sha256,"mediaType","byteSize","createdBy") VALUES
      (co_a,intake_a,'upload','foreign-file','private',co_b||'/invoice-intake/a.pdf',repeat('a',64),'application/pdf',1,actor);
    RAISE EXCEPTION 'Foreign source path accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  FOREACH n IN ARRAY ARRAY[-1::numeric,'NaN'::numeric,'Infinity'::numeric] LOOP
    BEGIN
      UPDATE public."invoiceIntakeSettings" SET "dailyBudgetUsd"=n WHERE "companyId"=co_a;
      RAISE EXCEPTION 'Invalid daily budget accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  END LOOP;
  INSERT INTO storage.buckets(id,name,public) VALUES('private','private',false) ON CONFLICT DO NOTHING;
  INSERT INTO storage.objects(bucket_id,name,owner) VALUES
    ('private',co_a||'/invoice-intake/invoice.pdf',actor::uuid),
    ('private',co_b||'/invoice-intake/invoice.pdf',actor::uuid),
    ('private',co_a||'/ordinary/document.pdf',actor::uuid);
  PERFORM set_config('test.intake.company_a',co_a,true);
  PERFORM set_config('test.intake.company_b',co_b,true);
  PERFORM set_config('test.intake.id',intake_a,true);
  PERFORM set_config('request.jwt.claim.sub',actor,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
END $fixtures$;
SELECT pass('Tenant links, attempt identity, deduplication, approval facts and finite budgets enforced');

SET LOCAL ROLE authenticated;
DO $rls$
DECLARE t text; visible integer; changed integer;
  co_a text:=current_setting('test.intake.company_a');
  co_b text:=current_setting('test.intake.company_b');
  actor text:=auth.uid()::text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoiceIntakeSettings','invoiceIntake','invoiceIntakeSource',
    'invoiceIntakeLine','invoiceRecognitionRule'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "companyId"=$1',t) INTO visible USING co_a;
    ASSERT visible>0,t||': authorized company visible';
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "companyId"=$1',t) INTO visible USING co_b;
    ASSERT visible=0,t||': other company hidden';
    EXECUTE format('UPDATE public.%I SET "updatedBy"=$1 WHERE "companyId"=$2',t) USING actor,co_a;
    GET DIAGNOSTICS changed=ROW_COUNT;
    ASSERT changed=0,t||': direct writes denied';
    EXECUTE format('DELETE FROM public.%I WHERE "companyId"=$1',t) USING co_a;
    GET DIAGNOSTICS changed=ROW_COUNT;
    ASSERT changed=0,t||': direct deletes denied';
  END LOOP;
  BEGIN
    INSERT INTO public."invoiceIntake"("companyId","createdBy") VALUES(co_a,actor);
    RAISE EXCEPTION 'Client inserted authoritative intake';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public."documentExtraction"("companyId","documentType","sourceDocument","storagePath","createdBy")
      VALUES(co_a,'salesRfq','Request for Quote',co_a||'/invoice-intake/invoice.pdf',actor);
    RAISE EXCEPTION 'Client spoofed actor/source via RFQ extraction';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  ASSERT (SELECT count(*) FROM public."documentExtraction" WHERE "companyId"=co_a)=3,
    'Authorized financial and legacy RFQ reads retained';
  UPDATE public."documentExtraction" SET "extractedData"='{"forged":true}' WHERE "companyId"=co_a;
  GET DIAGNOSTICS changed=ROW_COUNT;
  ASSERT changed=0,'Client cannot change raw extraction';
  ASSERT (SELECT count(*) FROM storage.objects WHERE bucket_id='private'
    AND name IN (co_a||'/invoice-intake/invoice.pdf',co_b||'/invoice-intake/invoice.pdf'))=1,
    'Broad storage policy cannot bypass company isolation';
  UPDATE storage.objects SET metadata='{"forged":true}' WHERE name=co_a||'/invoice-intake/invoice.pdf';
  GET DIAGNOSTICS changed=ROW_COUNT;
  ASSERT changed=0,'Financial evidence cannot be mutated';
  DELETE FROM storage.objects WHERE name=co_a||'/invoice-intake/invoice.pdf';
  GET DIAGNOSTICS changed=ROW_COUNT;
  ASSERT changed=0,'Financial evidence cannot be deleted';
  BEGIN
    INSERT INTO storage.objects(bucket_id,name,owner) VALUES('private',co_a||'/invoice-intake/forged.pdf',actor::uuid);
    RAISE EXCEPTION 'Client created authoritative financial source';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE storage.objects SET name=co_a||'/invoice-intake/moved.pdf' WHERE name=co_a||'/ordinary/document.pdf';
    RAISE EXCEPTION 'Client moved ordinary source into financial evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE storage.objects SET metadata='{"ordinary":true}' WHERE name=co_a||'/ordinary/document.pdf';
  GET DIAGNOSTICS changed=ROW_COUNT;
  ASSERT changed=1,'Ordinary uploads retain existing behavior';
END $rls$;
RESET ROLE;
SELECT pass('Authorized reads work; direct authoritative writes and storage-policy bypasses fail');

UPDATE public."userPermission" SET permissions='{}' WHERE id=current_setting('request.jwt.claim.sub');
SET LOCAL ROLE authenticated;
DO $denied$
DECLARE t text; visible integer; co text:=current_setting('test.intake.company_a');
BEGIN
  FOREACH t IN ARRAY ARRAY['invoiceIntakeSettings','invoiceIntake','invoiceIntakeSource',
    'invoiceIntakeLine','invoiceRecognitionRule'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "companyId"=$1',t) INTO visible USING co;
    ASSERT visible=0,t||': no financial permission means no financial visibility';
  END LOOP;
  ASSERT (SELECT count(*) FROM public."documentExtraction" WHERE "companyId"=co
    AND "documentType"='purchaseInvoice')=0,'Financial extraction hidden without permission';
  ASSERT (SELECT count(*) FROM public."documentExtraction" WHERE "companyId"=co
    AND "documentType"='salesRfq')=1,'Legacy RFQ remains readable to company employee';
  ASSERT (SELECT count(*) FROM storage.objects WHERE name=co||'/invoice-intake/invoice.pdf')=0,
    'Financial storage hidden despite broad permissive policy';
END $denied$;
RESET ROLE;
SELECT pass('Employee without invoicing access cannot read financial evidence; RFQ remains accessible');
SELECT * FROM finish();
ROLLBACK;
