-- Synthetic dependencies only. Apply exclusively to the labelled disposable DB.
CREATE TABLE IF NOT EXISTS public.company (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public."user" (id text PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.id(prefix text DEFAULT '') RETURNS text
LANGUAGE sql VOLATILE SET search_path = '' AS $$ SELECT prefix || pg_catalog.replace(gen_random_uuid()::text, '-', '') $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
INSERT INTO public.company(id) VALUES ('company-a'), ('company-b') ON CONFLICT DO NOTHING;
INSERT INTO public."user"(id) VALUES ('alice'), ('bob'), ('revoked'), ('automation') ON CONFLICT DO NOTHING;

ALTER TABLE public.company ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS "companyGroupId" text;
ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz;
CREATE TABLE IF NOT EXISTS public."userToCompany" ("userId" text NOT NULL,"companyId" text NOT NULL,PRIMARY KEY("userId","companyId"));
CREATE TABLE IF NOT EXISTS public."userPermission" (id text PRIMARY KEY,permissions jsonb NOT NULL DEFAULT '{}');
ALTER TABLE public.company ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."userToCompany" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."userPermission" ENABLE ROW LEVEL SECURITY;
INSERT INTO public."userToCompany" VALUES ('alice','company-a'),('bob','company-b'),('revoked','company-a') ON CONFLICT DO NOTHING;
