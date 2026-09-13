"""Prove a data-bearing legacy upgrade in a new, explicitly owned container.

The test replays immutable SQL bytes and checks ACL/OID/ledger continuity, RLS,
capability migration, counters, legacy cleanup and repeat-run checksum checking.
No existing developer or deployment database is accessed.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "packages/portal/migrations"
PUBLIC = ROOT / "packages/database/supabase/migrations"
CONTAINER = f"portal-rename-proof-{uuid.uuid4().hex[:12]}"


def command(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, check=True, **kwargs)


def sql(body):
    return command(
        [
            "docker",
            "exec",
            "-i",
            "-e",
            "PGPASSWORD=synthetic-test-only",
            CONTAINER,
            "psql",
            "-h",
            "127.0.0.1",
            "-XAt",
            "-U",
            "supabase_admin",
            "-d",
            "portal_test",
            "-v",
            "ON_ERROR_STOP=1",
        ],
        input=body,
    ).stdout.strip()


def snapshot(schema):
    # OIDs and ACL arrays encode ownership/permission identities independently of
    # their display names. A rename must preserve these exactly.
    return json.loads(
        sql(f"""SELECT json_build_object(
      'roles',(SELECT json_agg(oid ORDER BY oid) FROM pg_roles WHERE rolname IN
        ('{schema}_read','{schema}_ingest','{schema}_review','{schema}_actions','{schema}_migrate','{schema}_maintenance','{schema}_retention_owner','{schema}_enrollment_owner')),
      'tables',(SELECT json_agg(json_build_array(c.oid,c.relowner,(SELECT json_agg(a ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(c.relacl) a),c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.oid)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='{schema}' AND c.relkind='r'),
      'functions',(SELECT json_agg(json_build_array(p.oid,p.proowner,(SELECT json_agg(a ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(p.proacl) a),p.prosecdef) ORDER BY p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('{schema}','{schema}_metering')),
      'ledger',(SELECT json_agg(json_build_array(name,checksum) ORDER BY name) FROM {schema}_migrations.ledger WHERE name<'20260913192023'),
      'documents',(SELECT json_agg(json_build_array(id,"companyId",title,"currentVersionId") ORDER BY id) FROM {schema}.document)
    );""")
    )


def visible(schema, company):
    return sql(f"""BEGIN;SET LOCAL ROLE {schema}_read;
      SET LOCAL {schema}.actor_id='alice';SET LOCAL {schema}.company_id='{company}';
      SELECT id FROM {schema}.document ORDER BY id;ROLLBACK;""").splitlines()[4:-1]


try:
    command(
        [
            "docker",
            "run",
            "--detach",
            "--name",
            CONTAINER,
            "--label",
            "portal.disposable=true",
            "-e",
            "POSTGRES_PASSWORD=synthetic-test-only",
            "-e",
            "POSTGRES_DB=portal_test",
            "-p",
            "127.0.0.1::5432",
            "supabase/postgres:15.14.1.112",
            "postgres",
            "-D",
            "/etc/postgresql",
            "-c",
            "supautils.hint_roles=",
        ]
    )
    for attempt in range(60):
        try:
            sql("SELECT 1")
            break
        except subprocess.CalledProcessError:
            time.sleep(1)
    else:
        raise RuntimeError("Owned PostgreSQL did not become ready")
    sql((ROOT / "packages/portal/scripts/bootstrap-test.sql").read_text())
    sql((ROOT / "packages/portal/scripts/bootstrap-scheduler-test.sql").read_text())
    for name in (
        "20260908005300_knowledge-workforce-identity-resolver.sql",
        "20260908004744_knowledge-command-receipts.sql",
        "20260908014030_knowledge-procurement-schedule.sql",
        "20260911211525_knowledge-identity-revocation.sql",
        "20260908012959_knowledge-function-execution-boundary.sql",
    ):
        sql("BEGIN;" + (PUBLIC / name).read_text() + "\nCOMMIT;")
    sql(
        "CREATE SCHEMA knowledge_migrations;CREATE TABLE knowledge_migrations.ledger(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());"
    )
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if path.name >= "20260913192023":
            continue
        body = path.read_text()
        checksum = hashlib.sha256(body.encode()).hexdigest()
        sql(
            "BEGIN;"
            + body
            + f"\nRESET ROLE;INSERT INTO knowledge_migrations.ledger(name,checksum) VALUES('{path.name}','{checksum}');COMMIT;"
        )
    sql(
        (ROOT / "packages/portal/scripts/policy-fixtures.sql")
        .read_text()
        .replace("portal", "knowledge")
    )
    sql("""INSERT INTO knowledge_metering."requestPolicy" VALUES('company-a','knowledge.query',100,1000);
      INSERT INTO knowledge_metering."requestWindow" VALUES('company-a','knowledge.query','company',date_trunc('minute',now()),17);""")
    before = snapshot("knowledge")
    assert visible("knowledge", "company-a") == ["doc-a"]
    assert visible("knowledge", "company-b") == []
    sql(
        "BEGIN;"
        + (PUBLIC / "20260913192022_portal-public-identifiers.sql").read_text()
        + "\nCOMMIT;"
    )
    public_contract_sql = """SELECT json_agg(json_build_array(p.proname,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid)) ORDER BY p.proname,p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'"""
    public_contract = sql(public_contract_sql)
    assert (
        sql(
            "SELECT to_regprocedure('public.knowledge_resolve_workforce_identity(text,text,text)') IS NULL"
        )
        == "t"
    )
    # During the two-stream deployment gap, workforce revocation must still
    # reach the legacy binding. Roll back this probe to preserve baseline rows.
    assert (
        "\nt\n"
        in sql("""BEGIN;UPDATE public.\"user\" SET active=false WHERE id='alice';
      SELECT NOT active AND \"revocationVersion\">1 FROM knowledge.\"identityBinding\" WHERE id='id-alice';ROLLBACK;""")
    )
    info = json.loads(command(["docker", "inspect", CONTAINER]).stdout)[0]
    port = info["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"]
    environment = dict(
        os.environ,
        PORTAL_MIGRATION_DATABASE_URL=f"postgresql://supabase_admin:synthetic-test-only@127.0.0.1:{port}/portal_test",
    )

    def migrate():
        return command(
            [
                "corepack",
                "pnpm",
                "--filter",
                "@carbon/portal",
                "exec",
                "tsx",
                "scripts/migrate.ts",
            ],
            cwd=ROOT,
            env=environment,
        )

    assert json.loads(migrate().stdout)["applied"] == [
        "20260913192023_portal-private-identifiers.sql"
    ]
    assert (
        sql(public_contract_sql) == public_contract
    ), "Private migrations changed Carbon public RPC/type surface"
    after = snapshot("portal")
    for key in before:
        assert (
            after[key] == before[key]
        ), f"Changed {key}: {before[key]!r} -> {after[key]!r}"
    assert visible("portal", "company-a") == ["doc-a"]
    assert visible("portal", "company-b") == []
    try:
        sql(
            "\\set VERBOSITY verbose\nSET ROLE anon; SELECT public.portal_resolve_workforce_identity('https://identity.example.com','subject-a','company-a');"
        )
    except subprocess.CalledProcessError as error:
        assert "42501" in error.stderr, error.stderr
    else:
        raise AssertionError("Anonymous role could execute the workforce resolver")
    assert (
        sql(
            "SELECT capabilities[1] FROM portal.\"identityBinding\" WHERE id='id-alice'"
        )
        == "portal.read"
    )
    assert (
        sql(
            "SELECT count FROM portal_metering.\"requestWindow\" WHERE endpoint='portal.query'"
        )
        == "17"
    )
    assert (
        sql(
            "SELECT count(*) FROM pg_namespace WHERE nspname IN ('knowledge','knowledge_metering','knowledge_migrations')"
        )
        == "0"
    )
    assert sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'knowledge%'") == "0"
    assert (
        sql(
            "SELECT to_regprocedure('public.knowledge_resolve_workforce_identity(text,text,text)') IS NULL"
        )
        == "t"
    )
    assert (
        sql(
            "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('portal','portal_metering') AND CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END LIKE '%knowledge%'"
        )
        == "0"
    )
    assert json.loads(migrate().stdout)["applied"] == []
    sql(
        "UPDATE portal_migrations.ledger SET checksum='corrupted' WHERE name=(SELECT min(name) FROM portal_migrations.ledger)"
    )
    try:
        migrate()
    except subprocess.CalledProcessError as error:
        assert "Applied migration changed" in error.stderr
    else:
        raise AssertionError("Changed historical checksum was accepted")
    print(
        "Legacy upgrade: data, ACLs, OIDs, RLS, capabilities, quota state, namespace cleanup, repeat run and checksum refusal passed"
    )
finally:
    subprocess.run(
        ["docker", "rm", "--force", "--volumes", CONTAINER],
        capture_output=True,
        check=False,
    )
