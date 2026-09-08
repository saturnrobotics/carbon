#!/usr/bin/env python3
"""Restore a quiescent synthetic manual stack into new DB and object volumes."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
from urllib.parse import quote
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
COMPOSE = HERE / "compose.local.yaml"
PASSWORD = "synthetic-test-only"
DATABASE = "knowledge_test"
BOOTSTRAP_DATABASE = "knowledge_bootstrap"
PROJECT = "knowledge-manual-local"
STORAGE_VOLUME = f"{PROJECT}_knowledge_storage"
HELPER_IMAGE = "ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90"
HELPER_PLATFORM = "linux/amd64"
STORAGE_IMAGE = "fsouza/fake-gcs-server@sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef"


def run(arguments, *, input_text=None, capture=False, stdout_file=None):
    try:
        result = subprocess.run(
            arguments,
            input=input_text,
            text=input_text is not None or (capture and stdout_file is None),
            check=True,
            stdout=stdout_file if stdout_file is not None else (
                subprocess.PIPE if capture else subprocess.DEVNULL
            ),
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as error:
        diagnostic = error.stderr
        if isinstance(diagnostic, bytes):
            diagnostic = diagnostic.decode(errors="replace")
        raise RuntimeError((diagnostic or "command failed").strip()) from error
    return result.stdout.strip() if capture else ""


def compose(*arguments, capture=False):
    return run(
        ["docker", "compose", "-f", str(COMPOSE), *arguments], capture=capture
    )


def inspect(name):
    return json.loads(run(["docker", "inspect", name], capture=True))[0]


def assert_disposable(info, expected_stack=None):
    labels = info.get("Config", {}).get("Labels") or info.get("Labels") or {}
    if labels.get("knowledge.disposable") != "true":
        raise ValueError("recovery target must be labelled knowledge.disposable=true")
    if expected_stack and labels.get("knowledge.stack") != expected_stack:
        raise ValueError("recovery source is not the manual local stack")


def assert_source_storage_volume(info):
    labels = info.get("Labels") or {}
    if (
        labels.get("com.docker.compose.project") != PROJECT
        or labels.get("com.docker.compose.volume") != "knowledge_storage"
    ):
        raise ValueError("storage volume is not owned by the manual local stack")


def assert_storage_configuration(info):
    arguments = info.get("Args") or []
    if "-data" in arguments:
        raise ValueError("storage seed import would replace immutable object metadata")
    try:
        root_index = arguments.index("-filesystem-root")
    except ValueError as error:
        raise ValueError("storage does not persist its filesystem backend") from error
    if root_index + 1 >= len(arguments) or arguments[root_index + 1] != "/data":
        raise ValueError("storage filesystem root is not the persisted /data volume")


def db_sql(container, statement, capture=True, database=DATABASE):
    return admin_sql(container, database, statement, capture=capture)


def admin_sql(container, database, statement, capture=True):
    return run(
        [
            "docker", "exec", "-i", "-e", f"PGPASSWORD={PASSWORD}", container,
            "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin",
            "-d", database,
        ],
        input_text=statement,
        capture=capture,
    )


def prepare_empty_database(container):
    admin_sql(
        container,
        "postgres",
        f'CREATE DATABASE "{DATABASE}" OWNER supabase_admin TEMPLATE template0;',
        capture=False,
    )


def json_line(output):
    for line in reversed(output.splitlines()):
        if line.startswith(("[", "{")):
            return json.loads(line)
    raise AssertionError("database did not return recovery proof JSON")


def visible_documents(container, actor, company):
    return json_line(db_sql(container, f"""
BEGIN;
SET LOCAL ROLE knowledge_read;
SET LOCAL knowledge.actor_id='{actor}';
SET LOCAL knowledge.company_id='{company}';
SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM knowledge.document;
ROLLBACK;
"""))


def lexical_documents(container, linked_document, marker):
    return json_line(db_sql(container, f"""
BEGIN;
SET LOCAL ROLE knowledge_read;
SET LOCAL knowledge.actor_id='bob';
SET LOCAL knowledge.company_id='company-b';
SELECT coalesce(jsonb_agg("documentId" ORDER BY "documentId"),'[]')
FROM knowledge.search_lexical(
  'company-b',ARRAY['source-b'],{sql_literal(marker)},40
);
ROLLBACK;
"""))


def database_proof(container, linked_document, marker):
    linked = json_line(db_sql(container, f"""
SELECT jsonb_build_object(
  'objectKey',v."objectKey",
  'generation',v."objectGeneration",
  'sha256',v."contentHash"
)
FROM knowledge.document d
JOIN knowledge."documentVersion" v ON v.id=d."currentVersionId" AND v."companyId"=d."companyId"
WHERE d.id='{linked_document}' AND d."companyId"='company-b';
"""))
    return {
        "aliceVisible": visible_documents(container, "alice", "company-a"),
        "bobVisible": visible_documents(container, "bob", "company-b"),
        "tombstones": json_line(db_sql(container, """
SELECT coalesce(jsonb_agg(id ORDER BY id),'[]')
FROM knowledge.document WHERE "deletedAt" IS NOT NULL;
""")),
        "objectReferences": int(db_sql(container, """
SELECT count(*) FROM knowledge."documentVersion"
WHERE "objectKey"<>'' AND "objectGeneration"<>'';
""").splitlines()[-1]),
        "linkedReference": linked,
        "lexicalMatches": lexical_documents(container, linked_document, marker),
    }


def assert_database_proof(proof):
    for key in ("aliceVisible", "bobVisible", "tombstones"):
        if not proof.get(key):
            raise AssertionError(f"recovery database proof lacks {key}")
    if int(proof.get("objectReferences", 0)) < 1:
        raise AssertionError("recovery database proof lacks object references")
    linked = proof.get("linkedReference")
    if linked is not None and not all(
        linked.get(key) for key in ("objectKey", "generation", "sha256")
    ):
        raise AssertionError("linked database object reference is incomplete")
    if len(proof.get("lexicalMatches", [])) != 1:
        raise AssertionError("RLS lexical recovery proof must return exactly one document")


def security_proof(container):
    return json_line(db_sql(container, """
SELECT jsonb_build_object(
  'roles',(
    SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.rolname),'[]')
    FROM (
      SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
        rolreplication,rolconnlimit,rolbypassrls
      FROM pg_roles WHERE left(rolname,10)='knowledge_'
    ) r
  ),
  'memberships',(
    SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.granted_role,m.member),'[]')
    FROM (
      SELECT granted.rolname AS granted_role,member.rolname AS member,
        memberships.admin_option
      FROM pg_auth_members memberships
      JOIN pg_roles granted ON granted.oid=memberships.roleid
      JOIN pg_roles member ON member.oid=memberships.member
      WHERE left(granted.rolname,10)='knowledge_'
         OR left(member.rolname,10)='knowledge_'
    ) m
  ),
  'schemas',(
    SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.schema_name),'[]')
    FROM (
      SELECT n.nspname AS schema_name,pg_get_userbyid(n.nspowner) AS owner
      FROM pg_namespace n
      WHERE n.nspname IN ('knowledge','knowledge_metering')
    ) s
  ),
  'relations',(
    SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.schema_name,r.relation_name),'[]')
    FROM (
      SELECT n.nspname AS schema_name,c.relname AS relation_name,c.relkind,
        pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('knowledge','knowledge_metering')
        AND c.relkind IN ('r','p','v','m','S')
    ) r
  ),
  'relationAcl',(
    SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.schema_name,a.relation_name,a.grantee,a.grantor,a.privilege_type,a.is_grantable),'[]')
    FROM (
      SELECT n.nspname AS schema_name,c.relname AS relation_name,
        acl.grantee::regrole::text AS grantee,acl.grantor::regrole::text AS grantor,
        acl.privilege_type,acl.is_grantable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE c.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) acl
      WHERE n.nspname IN ('knowledge','knowledge_metering')
        AND c.relkind IN ('r','p','v','m','S')
    ) a
  ),
  'functions',(
    SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.schema_name,f.function_name,f.arguments),'[]')
    FROM (
      SELECT n.nspname AS schema_name,p.proname AS function_name,
        pg_get_function_identity_arguments(p.oid) AS arguments,
        pg_get_userbyid(p.proowner) AS owner,p.prosecdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('knowledge','knowledge_metering')
    ) f
  ),
  'functionAcl',(
    SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.schema_name,a.function_name,a.arguments,a.grantee,a.grantor,a.privilege_type,a.is_grantable),'[]')
    FROM (
      SELECT n.nspname AS schema_name,p.proname AS function_name,
        pg_get_function_identity_arguments(p.oid) AS arguments,
        acl.grantee::regrole::text AS grantee,acl.grantor::regrole::text AS grantor,
        acl.privilege_type,acl.is_grantable
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE n.nspname IN ('knowledge','knowledge_metering')
    ) a
  ),
  'policies',(
    SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.schemaname,p.tablename,p.policyname),'[]')
    FROM pg_policies p WHERE p.schemaname IN ('knowledge','knowledge_metering')
  )
);
"""))


def sql_identifier(value):
    return '"' + str(value).replace('"', '""') + '"'


def restore_roles(container, security):
    statements = []
    for role in security["roles"]:
        name = sql_identifier(role["rolname"])
        existence_name = sql_literal(role["rolname"])
        statements.append(
            "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname="
            f"{existence_name}) THEN CREATE ROLE {name}; END IF; END $$;"
        )
        attributes = [
            "SUPERUSER" if role["rolsuper"] else "NOSUPERUSER",
            "INHERIT" if role["rolinherit"] else "NOINHERIT",
            "CREATEROLE" if role["rolcreaterole"] else "NOCREATEROLE",
            "CREATEDB" if role["rolcreatedb"] else "NOCREATEDB",
            "LOGIN" if role["rolcanlogin"] else "NOLOGIN",
            "REPLICATION" if role["rolreplication"] else "NOREPLICATION",
            "BYPASSRLS" if role["rolbypassrls"] else "NOBYPASSRLS",
            f"CONNECTION LIMIT {role['rolconnlimit']}",
        ]
        statements.append(f"ALTER ROLE {name} WITH {' '.join(attributes)};")
    for membership in security["memberships"]:
        option = " WITH ADMIN OPTION" if membership["admin_option"] else ""
        statements.append(
            f"GRANT {sql_identifier(membership['granted_role'])} "
            f"TO {sql_identifier(membership['member'])}{option};"
        )
    db_sql(container, "\n".join(statements), capture=False)


def storage_origin(container):
    port = run(["docker", "port", container, "4443/tcp"], capture=True)
    return f"http://127.0.0.1:{port.rsplit(':', 1)[-1]}"


def wait_http(url, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=0.5):
                return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"service did not become ready: {url}")


def object_inventory(origin):
    with urlopen(f"{origin}/storage/v1/b?project=knowledge-e2e", timeout=5) as response:
        buckets = json.loads(response.read()).get("items", [])
    inventory = {}
    for bucket in buckets:
        bucket_name = bucket["name"]
        with urlopen(
            f"{origin}/storage/v1/b/{quote(bucket_name, safe='')}/o", timeout=5
        ) as response:
            objects = json.loads(response.read()).get("items", [])
        for item in objects:
            name = item["name"]
            generation = str(item["generation"])
            url = (
                f"{origin}/download/storage/v1/b/{quote(bucket_name, safe='')}/o/"
                f"{quote(name, safe='')}?alt=media&generation={quote(generation, safe='')}"
            )
            with urlopen(url, timeout=10) as response:
                body = response.read()
            inventory[f"{bucket_name}/{name}"] = {
                "generation": generation,
                "size": len(body),
                "sha256": sha256(body).hexdigest(),
                "contentType": item.get("contentType", "application/octet-stream"),
            }
    return inventory


def assert_exact_inventory(expected, actual):
    if set(expected) != set(actual):
        raise AssertionError("restored object key inventory changed")
    for key in expected:
        for field in ("generation", "size", "sha256", "contentType"):
            if expected[key].get(field) != actual[key].get(field):
                raise AssertionError(f"restored object {field} changed for {key}")


def wait_postgres(container, database=DATABASE, require_initialization=False):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        readiness = subprocess.run(
            ["docker", "exec", container, "pg_isready", "-h", "127.0.0.1",
             "-U", "supabase_admin", "-d", database],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if readiness.returncode == 0:
            if not require_initialization:
                return
            logs = subprocess.run(
                ["docker", "logs", container],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            ).stdout
            initialized = logs.rfind("PostgreSQL init process complete")
            final_ready = logs.rfind("database system is ready to accept connections")
            if initialized >= 0 and final_ready > initialized:
                return
        time.sleep(0.5)
    raise RuntimeError("restored PostgreSQL did not become ready")


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def add_linked_recovery_rows(container, suffix, object_id, object_meta):
    document = f"recovery-object-{suffix}"
    version = f"recovery-version-{suffix}"
    tombstone = f"recovery-tombstone-{suffix}"
    tombstone_version = f"recovery-tombstone-version-{suffix}"
    marker = f"recoverytoken{suffix}"
    _, object_key = object_id.split("/", 1)
    db_sql(container, f"""
BEGIN;
INSERT INTO knowledge.document(id,"companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification)
VALUES({sql_literal(document)},'company-b','bob','source-b',{sql_literal(document)},'Recovery object manual','bob','manual','published','internal');
INSERT INTO knowledge."documentVersion"(id,"companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus")
VALUES({sql_literal(version)},'company-b','bob',{sql_literal(document)},'recovery-1',{sql_literal(object_meta['sha256'])},{sql_literal(object_key)},{sql_literal(object_meta['generation'])},{sql_literal(object_meta['contentType'])},{object_meta['size']},clock_timestamp(),'manual-v1','ready');
UPDATE knowledge.document SET "currentVersionId"={sql_literal(version)},version=version+1 WHERE id={sql_literal(document)} AND "companyId"='company-b';
INSERT INTO knowledge.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,"tokenCount","embeddingProfile","indexGeneration")
VALUES({sql_literal('recovery-chunk-' + suffix)},'company-b','bob',{sql_literal(document)},{sql_literal(version)},0,{sql_literal(marker)},1,'manual-v1',1);
INSERT INTO knowledge.document(id,"companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification,"deletedAt")
VALUES({sql_literal(tombstone)},'company-b','bob','source-b',{sql_literal(tombstone)},'Recovery tombstone','bob','manual','withdrawn','internal',clock_timestamp());
INSERT INTO knowledge."documentVersion"(id,"companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus")
VALUES({sql_literal(tombstone_version)},'company-b','bob',{sql_literal(tombstone)},'recovery-1',{sql_literal(object_meta['sha256'])},{sql_literal(object_key)},{sql_literal(object_meta['generation'])},{sql_literal(object_meta['contentType'])},{object_meta['size']},clock_timestamp(),'manual-v1','ready');
UPDATE knowledge.document SET "currentVersionId"={sql_literal(tombstone_version)},version=version+1 WHERE id={sql_literal(tombstone)} AND "companyId"='company-b';
COMMIT;
""", capture=False)
    return document, marker, (document, tombstone)


def remove_linked_recovery_rows(container, documents):
    values = ",".join(sql_literal(item) for item in documents)
    db_sql(container, f"""
BEGIN;
DELETE FROM knowledge.outbox WHERE "companyId"='company-b' AND "entityId" IN ({values});
DELETE FROM knowledge.chunk WHERE "companyId"='company-b' AND "documentId" IN ({values});
UPDATE knowledge.document SET "currentVersionId"=NULL,version=version+1 WHERE "companyId"='company-b' AND id IN ({values});
DELETE FROM knowledge."documentVersion" WHERE "companyId"='company-b' AND "documentId" IN ({values});
DELETE FROM knowledge.document WHERE "companyId"='company-b' AND id IN ({values});
COMMIT;
""", capture=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--synthetic", action="store_true")
    parser.add_argument("--disposable", action="store_true")
    args = parser.parse_args()
    if not args.synthetic or not args.disposable:
        raise SystemExit("Both --synthetic and --disposable are required")
    running = set(filter(None, compose("ps", "--status", "running", "--services", capture=True).splitlines()))
    writers = running.intersection({"portal", "ingest", "inngest", "parser", "query"})
    if writers:
        raise SystemExit(f"Stop manual stack task services before recovery: {sorted(writers)}")
    compose("up", "-d", "postgres", "storage")
    source_database = compose("ps", "-q", "postgres", capture=True)
    source_storage = compose("ps", "-q", "storage", capture=True)
    assert_disposable(inspect(source_database), "manual-local")
    source_storage_info = inspect(source_storage)
    assert_disposable(source_storage_info, "manual-local")
    assert_storage_configuration(source_storage_info)
    assert_source_storage_volume(
        json.loads(run(["docker", "volume", "inspect", STORAGE_VOLUME], capture=True))[0]
    )
    wait_postgres(source_database)
    source_origin = storage_origin(source_storage)
    wait_http(f"{source_origin}/storage/v1/b")

    suffix = secrets.token_hex(5)
    target_database = f"knowledge-recovery-db-{suffix}"
    target_storage = f"knowledge-recovery-storage-{suffix}"
    target_network = f"knowledge-recovery-{suffix}"
    target_database_volume = f"knowledge-recovery-db-{suffix}"
    target_storage_volume = f"knowledge-recovery-storage-{suffix}"
    linked_documents = ()
    source_fixture_added = False
    with tempfile.TemporaryDirectory() as backup_directory_name:
        backup_directory = Path(backup_directory_name)
        database_archive = backup_directory / "knowledge.dump"
        storage_archive = backup_directory / "storage.tar"
        try:
            expected_objects = object_inventory(source_origin)
            if not expected_objects:
                raise AssertionError("source stack has no persisted objects to recover")
            object_id = next(
                (key for key, item in expected_objects.items() if item["contentType"] == "application/pdf"),
                next(iter(expected_objects)),
            )
            linked_document, marker, linked_documents = add_linked_recovery_rows(
                source_database, suffix, object_id, expected_objects[object_id]
            )
            source_fixture_added = True
            expected_database = database_proof(source_database, linked_document, marker)
            assert_database_proof(expected_database)
            if expected_database["lexicalMatches"] != [linked_document]:
                raise AssertionError("RLS lexical proof did not return only the linked active document")
            if expected_database["linkedReference"] != {
                "objectKey": object_id.split("/", 1)[1],
                "generation": expected_objects[object_id]["generation"],
                "sha256": expected_objects[object_id]["sha256"],
            }:
                raise AssertionError("database reference does not identify persisted object bytes")
            expected_security = security_proof(source_database)
            with database_archive.open("wb") as archive:
                run(
                    ["docker", "exec", "-e", f"PGPASSWORD={PASSWORD}", source_database,
                     "pg_dump", "-U", "supabase_admin", "-d", DATABASE, "-Fc"],
                    stdout_file=archive,
                )
            compose("stop", "storage", "postgres")
            run(["docker", "run", "--rm", "--platform", HELPER_PLATFORM,
                 "--volume", f"{STORAGE_VOLUME}:/source:ro",
                 "--volume", f"{backup_directory}:/backup", HELPER_IMAGE,
                 "tar", "--xattrs", "--xattrs-include=user.*", "--numeric-owner",
                 "-C", "/source", "-cpf", "/backup/storage.tar", "."])

            run(["docker", "network", "create", "--label", "knowledge.disposable=true", target_network])
            for volume in (target_database_volume, target_storage_volume):
                run(["docker", "volume", "create", "--label", "knowledge.disposable=true", volume])
            run(["docker", "run", "--rm", "--platform", HELPER_PLATFORM,
                 "--volume", f"{target_storage_volume}:/restore",
                 "--volume", f"{backup_directory}:/backup:ro", HELPER_IMAGE,
                 "tar", "--xattrs", "--xattrs-include=user.*", "--numeric-owner",
                 "-C", "/restore", "-xpf", "/backup/storage.tar"])
            source_database_image = inspect(source_database)["Config"]["Image"]
            run(["docker", "run", "--detach", "--name", target_database,
                 "--label", "knowledge.disposable=true", "--network", target_network,
                 "--network-alias", "postgres", "--env", f"POSTGRES_PASSWORD={PASSWORD}",
                 "--env", "POSTGRES_USER=supabase_admin", "--env", f"POSTGRES_DB={BOOTSTRAP_DATABASE}",
                 "--volume", f"{target_database_volume}:/var/lib/postgresql/data", source_database_image])
            wait_postgres(
                target_database,
                BOOTSTRAP_DATABASE,
                require_initialization=True,
            )
            prepare_empty_database(target_database)
            restore_roles(target_database, expected_security)
            run(["docker", "cp", str(database_archive), f"{target_database}:/tmp/knowledge.dump"])
            run(["docker", "exec", "-e", f"PGPASSWORD={PASSWORD}", target_database,
                 "pg_restore", "-U", "supabase_admin", "-d", DATABASE,
                 "--exit-on-error", "/tmp/knowledge.dump"])
            run(["docker", "run", "--detach", "--name", target_storage,
                 "--label", "knowledge.disposable=true", "--network", target_network,
                 "--publish", "127.0.0.1::4443", "--volume", f"{target_storage_volume}:/data",
                 "--entrypoint", "/bin/fake-gcs-server",
                 STORAGE_IMAGE, "-scheme", "http", "-host", "0.0.0.0", "-port", "4443",
                 "-filesystem-root", "/data"])
            restored_origin = storage_origin(target_storage)
            wait_http(f"{restored_origin}/storage/v1/b")
            restored_objects = object_inventory(restored_origin)
            assert_exact_inventory(expected_objects, restored_objects)
            restored_database = database_proof(target_database, linked_document, marker)
            assert_database_proof(restored_database)
            if restored_database != expected_database:
                raise AssertionError("restored ACL, tombstone, or object-reference state changed")
            restored_security = security_proof(target_database)
            if restored_security != expected_security:
                raise AssertionError("restored role, ownership, RLS, policy, or ACL state changed")
            print(json.dumps({
                "databaseRestored": True,
                "authorizationPreserved": True,
                "tombstonesPreserved": True,
                "securityOwnershipAndAclPreserved": True,
                "rlsLexicalSearchDocument": linked_document,
                "objectCount": len(restored_objects),
                "objectBytes": sum(item["size"] for item in restored_objects.values()),
                "exactGenerationsAndHashes": True,
                "linkedObject": expected_database["linkedReference"],
            }, indent=2))
        finally:
            for container in (target_storage, target_database):
                subprocess.run(["docker", "container", "rm", "--force", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for volume in (target_storage_volume, target_database_volume):
                subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["docker", "network", "rm", target_network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if source_fixture_added:
                compose("up", "-d", "postgres")
                wait_postgres(source_database)
                remove_linked_recovery_rows(source_database, linked_documents)
                compose("stop", "postgres")


if __name__ == "__main__":
    main()
