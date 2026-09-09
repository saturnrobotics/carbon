-- Synthetic predecessors for the scheduler integration fixture only. The actual
-- receipt/schedule tables and constraints are loaded from Carbon migrations.
CREATE TABLE IF NOT EXISTS public.employee (
  id text NOT NULL REFERENCES public."user"(id),
  "companyId" text NOT NULL REFERENCES public.company(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id, "companyId")
);
ALTER TABLE public."userToCompany" ADD COLUMN IF NOT EXISTS role text;
CREATE TABLE IF NOT EXISTS public."purchaseOrder" (id text PRIMARY KEY);

-- These default-deny stubs only let the source migrations declare their policies.
-- This fixture proves scheduler/actor-recheck behavior, not ERP browser policy.
CREATE OR REPLACE FUNCTION public.has_role(text, text) RETURNS boolean
LANGUAGE sql AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.has_company_permission(text, text) RETURNS boolean
LANGUAGE sql AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.get_companies_with_employee_permission(text)
RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY[]::text[] $$;

-- A trusted jobs worker needs canonical-table access. Keep it separate from the
-- knowledge migrator and restricted read/ingest roles used by the RLS proofs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='knowledge_test_scheduler') THEN
    CREATE ROLE knowledge_test_scheduler LOGIN NOINHERIT NOSUPERUSER BYPASSRLS
      PASSWORD 'synthetic-test-only';
  END IF;
END $$;
