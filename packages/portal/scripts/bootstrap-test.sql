-- Synthetic dependencies only. Apply exclusively to the labelled disposable DB.
CREATE TABLE IF NOT EXISTS public.company (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public."user" (id text PRIMARY KEY);
-- Carbon's real identifier generator, reproduced from its own migrations so the
-- fixture carries the privilege closure a real Carbon database imposes:
-- public.id(text) -> public.uuid_to_base58(uuid) -> extensions.uuid_generate_v4().
-- A gen_random_uuid() stand-in needs none of those grants, and while one stood
-- here every suite passed against an ID generator that could not reproduce the
-- denial a knowledge role hits on first contact with Carbon.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
DO $carbon_id$ BEGIN
  IF to_regprocedure('extensions.uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'uuid-ossp must be installed in the extensions schema before the identifier generator';
  END IF;
  -- CREATE OR REPLACE cannot rename an input parameter, so retire a fixture
  -- left by the earlier stand-in. A fixture whose table defaults already
  -- reference it must be recreated; the container is disposable by design.
  IF coalesce((SELECT p.proargnames[1] FROM pg_proc p
               WHERE p.oid = to_regprocedure('public.id(text)')), '_prefix') <> '_prefix' THEN
    DROP FUNCTION public.id(text);
  END IF;
END $carbon_id$;
-- packages/database/supabase/migrations/20250728114226_xid-to-uuid.sql
CREATE OR REPLACE FUNCTION public.uuid_to_base58(_uuid UUID)
    RETURNS TEXT
    LANGUAGE plpgsql
AS
$$
DECLARE
    _alphabet TEXT := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    _bytes BYTEA;
    _num NUMERIC := 0;
    _result TEXT := '';
    _remainder INT;
    _i INT;
BEGIN
    _bytes := decode(replace(_uuid::TEXT, '-', ''), 'hex');
    FOR _i IN 0..15 LOOP
        _num := _num * 256 + get_byte(_bytes, _i);
    END LOOP;
    IF _num = 0 THEN
        RETURN substring(_alphabet, 1, 1);
    END IF;
    WHILE _num > 0 LOOP
        _remainder := (_num % 58)::INT;
        _result := substring(_alphabet, _remainder + 1, 1) || _result;
        _num := floor(_num / 58);
    END LOOP;
    RETURN _result;
END;
$$;
-- packages/database/supabase/migrations/20250923225147_uuid-ship-fix.sql
CREATE OR REPLACE FUNCTION public.id(_prefix TEXT DEFAULT NULL)
    RETURNS TEXT
    LANGUAGE plpgsql
AS
$$
DECLARE
    _uuid TEXT;
BEGIN
    _uuid := REPLACE(uuid_to_base58(extensions.uuid_generate_v4()), '-', '');
    IF _prefix IS NOT NULL THEN
        RETURN _prefix || '_' || _uuid;
    ELSE
        RETURN _uuid;
    END IF;
END;
$$;
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
