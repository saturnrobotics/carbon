"""Recreate synthetic prerequisites in an existing labelled test container.

Never resets a schema or a database. Container creation is deliberately separate.
"""
import json
import os
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[3]
container = os.environ.get("KNOWLEDGE_TEST_CONTAINER", "knowledge-schema-test")
info = json.loads(subprocess.check_output(["docker", "inspect", container]))[0]
if info["Config"].get("Labels", {}).get("knowledge.disposable") != "true":
    raise SystemExit("Refusing an unlabelled container")
ports = info["NetworkSettings"]["Ports"].get("5432/tcp", [])
if len(ports) != 1 or ports[0]["HostIp"] != "127.0.0.1" or ports[0]["HostPort"] == "5432":
    raise SystemExit("Test PostgreSQL requires a nonstandard loopback-only port")
port = ports[0]["HostPort"]
base = ["docker", "exec", "-i", "-e", "PGPASSWORD=synthetic-test-only", container,
        "psql", "-X", "-U", "supabase_admin", "-d", "knowledge_test", "-v", "ON_ERROR_STOP=1"]
def sql(body):
    result = subprocess.run(base, input=body.encode(), capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode())
    return result.stdout.decode()

sql((Path(__file__).with_name("bootstrap-test.sql")).read_text())
if "t" not in sql("SELECT to_regprocedure(\'public.knowledge_resolve_workforce_identity(text,text,text)\') IS NOT NULL;").split():
    sql((root / "packages/database/supabase/migrations/20260908005300_knowledge-workforce-identity-resolver.sql").read_text())
sql("CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;")
environment = dict(os.environ, KNOWLEDGE_MIGRATION_DATABASE_URL=f"postgresql://supabase_admin:synthetic-test-only@127.0.0.1:{port}/knowledge_test")
subprocess.run(["corepack", "pnpm", "--filter", "@carbon/knowledge", "exec", "tsx", "scripts/migrate.ts"], cwd=root, env=environment, check=True)
sql("""DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='knowledge_test_migrator') THEN
 CREATE ROLE knowledge_test_migrator LOGIN PASSWORD 'synthetic-test-only'; END IF; END $$;
 GRANT knowledge_migrate,knowledge_read TO knowledge_test_migrator;
 GRANT CREATE ON DATABASE knowledge_test TO knowledge_test_migrator;
 CREATE OR REPLACE FUNCTION public.knowledge_fixture_mutator() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ UPDATE public.\"user\" SET active=false WHERE id='alice' $$;
 GRANT USAGE ON SCHEMA public TO authenticated;
 GRANT EXECUTE ON FUNCTION public.knowledge_fixture_mutator() TO authenticated;
""")
sql((root / "packages/database/supabase/migrations/20260908012959_knowledge-function-execution-boundary.sql").read_text())
sql(Path(__file__).with_name("policy-fixtures.sql").read_text())
sql('INSERT INTO knowledge_metering."requestPolicy" VALUES (\'company-a\',\'knowledge.query\',1000,10000),(\'company-b\',\'knowledge.query\',1000,10000) ON CONFLICT DO NOTHING;')
print("Synthetic knowledge fixture is ready; no database reset performed")
