-- Run with psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f this-file.sql.
-- Uses synthetic records and rolls back every change, including on failure.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "app.sync_in_progress" = 'true';
-- Match the Storage API's query context so the assertions exercise RLS.
SET LOCAL "storage.allow_delete_query" = 'true';

-- A permissive policy models owner grants and future broader storage policies.
-- The Mercury restrictive policies must still protect bank evidence.
CREATE POLICY "Mercury harness permissive storage" ON storage.objects
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

DO $test$
DECLARE
  actor TEXT := gen_random_uuid()::TEXT;
  company_a TEXT := id();
  company_b TEXT := id();
  supplier_a TEXT;
  supplier_b TEXT;
  interaction_b TEXT;
  invoice_b TEXT;
  invalid_amount NUMERIC;
BEGIN
  INSERT INTO public."user" (id, email) VALUES (actor, actor || '@example.com');
  INSERT INTO public."currencyCode" (code, name) VALUES ('USD', 'US Dollar') ON CONFLICT DO NOTHING;
  INSERT INTO public."company" (id, name, "baseCurrencyCode") VALUES
    (company_a, 'Payment Import Test A', 'USD'),
    (company_b, 'Payment Import Test B', 'USD');
  INSERT INTO public."userToCompany" ("userId", "companyId", role) VALUES (actor, company_a, 'employee');
  INSERT INTO public."userPermission" (id, permissions)
    VALUES (actor, jsonb_build_object('invoicing_view', jsonb_build_array(company_a), 'settings_update', jsonb_build_array(company_a)))
    ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions;
  INSERT INTO public."supplier" (name, "companyId", "createdBy", "readableId")
    VALUES ('Synthetic Vendor A', company_a, actor, 'TEST-A') RETURNING id INTO supplier_a;
  INSERT INTO public."supplier" (name, "companyId", "createdBy", "readableId")
    VALUES ('Synthetic Vendor B', company_b, actor, 'TEST-B') RETURNING id INTO supplier_b;
  INSERT INTO public."supplierInteraction" ("companyId", "supplierId")
    VALUES (company_b, supplier_b) RETURNING id INTO interaction_b;
  INSERT INTO public."purchaseInvoice" ("invoiceId", "currencyCode", "companyId", "createdBy", "supplierInteractionId", "supplierId")
    VALUES ('TEST-INVOICE', 'USD', company_b, actor, interaction_b, supplier_b) RETURNING id INTO invoice_b;

  INSERT INTO public."mercurySyncSettings" ("companyId", "createdBy") VALUES (company_a, actor), (company_b, actor);
  INSERT INTO public."mercuryRecipientMapping" ("companyId", "mercuryRecipientId", "supplierId", "createdBy") VALUES
    (company_a, 'recipient-example', supplier_a, actor),
    (company_b, 'recipient-example', supplier_b, actor);
  INSERT INTO public."mercuryTransactionImport" ("companyId", "mercuryTransactionId", "mercuryAccountId", "remoteStatus", amount, "currencyCode", "transactionDate", "createdBy") VALUES
    (company_a, 'transaction-example', 'account-example', 'sent', 123.45, 'USD', '2026-09-01', actor),
    (company_b, 'transaction-example', 'account-example', 'sent', 123.45, 'USD', '2026-09-01', actor);
  INSERT INTO storage.buckets (id, name, public) VALUES ('private', 'private', FALSE) ON CONFLICT DO NOTHING;
  INSERT INTO storage.objects (bucket_id, name, owner) VALUES
    ('private', company_a || '/mercury/invoice.pdf', actor::UUID),
    ('private', company_b || '/mercury/invoice.pdf', actor::UUID),
    ('private', company_a || '/example/ordinary.pdf', actor::UUID);

  BEGIN
    INSERT INTO public."mercuryRecipientMapping" ("companyId", "mercuryRecipientId", "supplierId", "createdBy")
      VALUES (company_a, 'foreign-recipient', supplier_b, actor);
    RAISE EXCEPTION 'Cross-company recipient mapping was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public."mercuryTransactionImport" SET "supplierId" = supplier_b WHERE "companyId" = company_a;
    RAISE EXCEPTION 'Cross-company supplier link was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public."mercuryTransactionImport" SET "purchaseInvoiceId" = invoice_b WHERE "companyId" = company_a;
    RAISE EXCEPTION 'Cross-company invoice link was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO public."mercuryRecipientMapping" ("companyId", "mercuryRecipientId", "supplierId", "createdBy")
      VALUES (company_a, 'recipient-example', supplier_a, actor);
    RAISE EXCEPTION 'Duplicate recipient was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO public."mercuryTransactionImport" ("companyId", "mercuryTransactionId", "mercuryAccountId", "remoteStatus", amount, "currencyCode", "transactionDate", "createdBy")
      VALUES (company_a, 'transaction-example', 'account-example', 'sent', 123.45, 'USD', '2026-09-01', actor);
    RAISE EXCEPTION 'Duplicate transaction was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE public."mercuryTransactionImport" SET amount = -1 WHERE "companyId" = company_a;
    RAISE EXCEPTION 'Negative imported expense was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  FOREACH invalid_amount IN ARRAY ARRAY['NaN'::NUMERIC, 'Infinity'::NUMERIC] LOOP
    BEGIN
      UPDATE public."mercuryTransactionImport" SET amount = invalid_amount WHERE "companyId" = company_a;
      RAISE EXCEPTION 'Non-finite imported expense was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  END LOOP;

  ASSERT (SELECT count(*) FROM public."mercuryTransactionImport" WHERE "companyId" IN (company_a, company_b)) = 2,
    'Same remote transaction ID must be allowed in separate companies';
  ASSERT (SELECT bool_and(NOT enabled) FROM public."mercurySyncSettings" WHERE "companyId" IN (company_a, company_b)),
    'Sync must start disabled';
  PERFORM set_config('test.company_a', company_a, true);
  PERFORM set_config('test.company_b', company_b, true);
  PERFORM set_config('test.supplier_a', supplier_a, true);
  PERFORM set_config('request.jwt.claim.sub', actor, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::TEXT, true);
  RAISE NOTICE 'Company-scoped links, deduplication, amount validation and disabled default: PASS';
END $test$;

SET LOCAL ROLE authenticated;
DO $test$
DECLARE
  table_name TEXT;
  visible INTEGER;
  changed INTEGER;
  company_a TEXT := current_setting('test.company_a');
  company_b TEXT := current_setting('test.company_b');
  actor TEXT := auth.uid()::TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['mercurySyncSettings', 'mercuryRecipientMapping', 'mercuryTransactionImport'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "companyId" IN ($1,$2)', table_name) INTO visible USING company_a, company_b;
    ASSERT visible = 1, table_name || ': reader must see only their authorized company';
    EXECUTE format('UPDATE public.%I SET "updatedBy" = $1 WHERE "companyId" = $2', table_name) USING actor, company_a;
    GET DIAGNOSTICS changed = ROW_COUNT;
    ASSERT changed = 0, table_name || ': authenticated writes must use the authorized server route';
    EXECUTE format('DELETE FROM public.%I WHERE "companyId" = $1', table_name) USING company_a;
    GET DIAGNOSTICS changed = ROW_COUNT;
    ASSERT changed = 0, table_name || ': authenticated deletes must be denied';
  END LOOP;
  BEGIN
    INSERT INTO public."mercurySyncSettings" ("companyId", "createdBy") VALUES (company_b, actor);
    RAISE EXCEPTION 'Authenticated settings insertion was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public."mercuryRecipientMapping" ("companyId", "mercuryRecipientId", "supplierId", "createdBy")
      VALUES (company_a, 'forged-recipient', current_setting('test.supplier_a'), actor);
    RAISE EXCEPTION 'Authenticated mapping insertion was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public."mercuryTransactionImport" ("companyId", "mercuryTransactionId", "mercuryAccountId", "remoteStatus", amount, "currencyCode", "transactionDate", "createdBy")
      VALUES (company_a, 'forged-payment', 'account-example', 'sent', 1, 'USD', '2026-09-01', actor);
    RAISE EXCEPTION 'Authenticated payment evidence insertion was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'Authorized-company RLS visibility and all direct write denials: PASS';

  SELECT count(*) INTO visible FROM storage.objects
    WHERE bucket_id = 'private' AND name IN (company_a || '/mercury/invoice.pdf', company_b || '/mercury/invoice.pdf');
  ASSERT visible = 1, 'Permissive owner policy must not bypass evidence company isolation';
  UPDATE storage.objects SET metadata = '{"tampered":true}'::JSONB
    WHERE bucket_id = 'private' AND name = company_a || '/mercury/invoice.pdf';
  GET DIAGNOSTICS changed = ROW_COUNT;
  ASSERT changed = 0, 'Authenticated users must not modify source evidence';
  DELETE FROM storage.objects WHERE bucket_id = 'private' AND name = company_a || '/mercury/invoice.pdf';
  GET DIAGNOSTICS changed = ROW_COUNT;
  ASSERT changed = 0, 'Authenticated users must not delete source evidence';
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner)
      VALUES ('private', company_a || '/mercury/forged.pdf', actor::UUID);
    RAISE EXCEPTION 'Authenticated source evidence insertion was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE storage.objects SET name = company_a || '/mercury/forged.pdf'
      WHERE bucket_id = 'private' AND name = company_a || '/example/ordinary.pdf';
    RAISE EXCEPTION 'Moving an ordinary upload into protected source evidence was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE storage.objects SET metadata = '{"ordinary":true}'::JSONB
    WHERE bucket_id = 'private' AND name = company_a || '/example/ordinary.pdf';
  GET DIAGNOSTICS changed = ROW_COUNT;
  ASSERT changed = 1, 'Evidence restrictions must not block ordinary uploads';
  RAISE NOTICE 'Storage evidence remains private and immutable despite permissive grants: PASS';
END $test$;

RESET ROLE;
UPDATE public."userPermission" SET permissions = '{}'::JSONB WHERE id = current_setting('request.jwt.claim.sub');
SET LOCAL ROLE authenticated;
DO $test$
DECLARE table_name TEXT; visible INTEGER;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['mercurySyncSettings', 'mercuryRecipientMapping', 'mercuryTransactionImport'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "companyId" = $1', table_name) INTO visible USING current_setting('test.company_a');
    ASSERT visible = 0, table_name || ': employee without invoicing permission must not read bank evidence';
  END LOOP;
  SELECT count(*) INTO visible FROM storage.objects WHERE bucket_id = 'private'
    AND name = current_setting('test.company_a') || '/mercury/invoice.pdf';
  ASSERT visible = 0, 'Employee without invoicing permission must not read source evidence';
  RAISE NOTICE 'Employee without invoicing permission cannot read bank evidence: PASS';
END $test$;
RESET ROLE;
ROLLBACK;
\echo 'ALL MERCURY IMPORT SCENARIOS PASSED'
