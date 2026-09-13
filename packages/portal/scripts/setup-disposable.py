"""Recreate synthetic prerequisites in an existing labelled test container.

Never resets a schema or a database. Container creation is deliberately separate.
"""

import json
import os
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[3]
container = os.environ.get("PORTAL_TEST_CONTAINER", "portal-schema-test")
info = json.loads(subprocess.check_output(["docker", "inspect", container]))[0]
if info["Config"].get("Labels", {}).get("portal.disposable") != "true":
    raise SystemExit("Refusing an unlabelled container")
ports = info["NetworkSettings"]["Ports"].get("5432/tcp", [])
if (
    len(ports) != 1
    or ports[0]["HostIp"] != "127.0.0.1"
    or ports[0]["HostPort"] == "5432"
):
    raise SystemExit("Test PostgreSQL requires a nonstandard loopback-only port")
port = ports[0]["HostPort"]
base = [
    "docker",
    "exec",
    "-i",
    "-e",
    "PGPASSWORD=synthetic-test-only",
    container,
    "psql",
    "-X",
    "-U",
    "supabase_admin",
    "-d",
    "portal_test",
    "-v",
    "ON_ERROR_STOP=1",
]


def sql(body):
    result = subprocess.run(base, input=body.encode(), capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode())
    return result.stdout.decode()


sql((Path(__file__).with_name("bootstrap-test.sql")).read_text())
sql(Path(__file__).with_name("bootstrap-scheduler-test.sql").read_text())
# Historical public SQL is immutable and runs before the one forward rename.
# Reusing a Portal fixture must not recreate legacy objects or policy roles.
if (
    "t"
    not in sql(
        "SELECT to_regprocedure('public.portal_resolve_workforce_identity(text,text,text)') IS NOT NULL;"
    ).split()
):
    for migration in (
        "20260908005300_knowledge-workforce-identity-resolver.sql",
        "20260908004744_knowledge-command-receipts.sql",
        "20260908014030_knowledge-procurement-schedule.sql",
        "20260911211525_knowledge-identity-revocation.sql",
        "20260908012959_knowledge-function-execution-boundary.sql",
        "20260913192022_portal-public-identifiers.sql",
    ):
        sql(
            "BEGIN;\n"
            + (root / "packages/database/supabase/migrations" / migration).read_text()
            + "\nCOMMIT;"
        )
sql(
    "CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;"
)
environment = dict(
    os.environ,
    PORTAL_MIGRATION_DATABASE_URL=f"postgresql://supabase_admin:synthetic-test-only@127.0.0.1:{port}/portal_test",
)
subprocess.run(
    [
        "corepack",
        "pnpm",
        "--filter",
        "@carbon/portal",
        "exec",
        "tsx",
        "scripts/migrate.ts",
    ],
    cwd=root,
    env=environment,
    check=True,
)
sql("""DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='portal_test_migrator') THEN
 CREATE ROLE portal_test_migrator LOGIN PASSWORD 'synthetic-test-only'; END IF; END $$;
 GRANT portal_migrate,portal_read TO portal_test_migrator;
 GRANT CREATE ON DATABASE portal_test TO portal_test_migrator;
 CREATE OR REPLACE FUNCTION public.portal_fixture_mutator() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ UPDATE public.\"user\" SET active=false WHERE id='alice' $$;
 REVOKE ALL ON FUNCTION public.portal_fixture_mutator() FROM PUBLIC;
 GRANT USAGE ON SCHEMA public TO authenticated;
 GRANT EXECUTE ON FUNCTION public.portal_fixture_mutator() TO authenticated,portal_test_migrator;
""")
sql(Path(__file__).with_name("policy-fixtures.sql").read_text())
sql(
    "INSERT INTO portal_metering.\"requestPolicy\" VALUES ('company-a','portal.query',1000,10000),('company-b','portal.query',1000,10000) ON CONFLICT DO NOTHING;"
)
# The worker's tables default their ids to public.id(text), so it needs the same
# helper closure every portal writer needs, not just the generator itself.
sql("""
GRANT USAGE ON SCHEMA public, extensions TO portal_test_scheduler;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.company, public."user", public.employee, public."userToCompany",
  public."userPermission", public."purchaseOrder", public."portalCommandReceipt",
  public."portalProcurementSchedule" TO portal_test_scheduler;
GRANT EXECUTE ON FUNCTION public.id(text), public.uuid_to_base58(uuid),
  extensions.uuid_generate_v4() TO portal_test_scheduler;
""")
print("Synthetic portal fixture is ready; no database reset performed")
