#!/usr/bin/env python3
"""Prove a knowledge backup in isolated databases inside a disposable container."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
from typing import Any


CONTAINER = os.environ.get("KNOWLEDGE_TEST_CONTAINER", "knowledge-schema-test")
SOURCE_DATABASE = "knowledge_test"
PASSWORD = "synthetic-test-only"


def validate_container_info(info: dict[str, Any]) -> str:
    if (info.get("Config", {}).get("Labels") or {}).get("knowledge.disposable") != "true":
        raise ValueError("Recovery verification requires a labelled disposable container")
    ports = info.get("NetworkSettings", {}).get("Ports", {}).get("5432/tcp") or []
    if (
        len(ports) != 1
        or ports[0].get("HostIp") not in {"127.0.0.1", "::1"}
        or not ports[0].get("HostPort")
        or ports[0]["HostPort"] == "5432"
    ):
        raise ValueError("Recovery verification requires a nonstandard loopback PostgreSQL port")
    return str(ports[0]["HostPort"])


def docker_postgres(*arguments: str, input_text: str | None = None, capture: bool = False) -> str:
    result = subprocess.run(
        ["docker", "exec", "-i", "-e", f"PGPASSWORD={PASSWORD}", CONTAINER, *arguments],
        input=input_text,
        text=True,
        check=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    return result.stdout.strip() if capture else ""


def sql(database: str, statement: str) -> str:
    return docker_postgres(
        "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin",
        "-d", database, input_text=statement, capture=True
    )


def json_line(output: str) -> Any:
    for line in reversed(output.splitlines()):
        if line.startswith(("[", "{")):
            return json.loads(line)
    raise AssertionError("Recovery verification did not return its bounded JSON proof")


def restore(database: str, archive: str) -> None:
    docker_postgres("createdb", "-U", "supabase_admin", "-T", "template0", database)
    docker_postgres("pg_restore", "-U", "supabase_admin", "-d", database, archive)


def canonical_counts(database: str) -> dict[str, int]:
    return json_line(sql(database, """
SELECT jsonb_build_object(
 'sources',(SELECT count(*) FROM knowledge.source),
 'bindings',(SELECT count(*) FROM knowledge."identityBinding"),
 'grants',(SELECT count(*) FROM knowledge."grant"),
 'objectReferences',(SELECT count(*) FROM knowledge."documentVersion" WHERE "objectKey"<>'' AND "objectGeneration"<>'')
)
"""))


def verify_policy_and_rebuild_state(database: str) -> None:
    hidden_exists = sql(database, "SELECT count(*) FROM knowledge.document WHERE id='doc-hidden'").splitlines()[-1]
    if hidden_exists != "1":
        raise AssertionError("Synthetic denied document was not restored")
    visible = json_line(sql(database, """
BEGIN;
SET LOCAL ROLE knowledge_read;
SET LOCAL knowledge.actor_id='alice';
SET LOCAL knowledge.company_id='company-a';
SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM knowledge.document;
ROLLBACK
"""))
    if "doc-a" not in visible or "doc-hidden" in visible or "recovery-retired" in visible:
        raise AssertionError("Restored authorization or tombstone behavior changed")
    rebuildable = json_line(sql(database, """
SET ROLE knowledge_maintenance;
SELECT coalesce(jsonb_agg("documentId" ORDER BY "documentId"),'[]')
FROM knowledge.recovery_index_candidates(500)
"""))
    if "doc-a" not in rebuildable or "doc-hidden" not in rebuildable or "recovery-retired" in rebuildable:
        raise AssertionError("Restored rebuild candidates do not honor canonical active/tombstone state")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--synthetic", action="store_true")
    parser.add_argument("--disposable", action="store_true")
    args = parser.parse_args()
    if not args.synthetic or not args.disposable:
        raise SystemExit("Both --synthetic and --disposable are required")
    inspected = json.loads(
        subprocess.run(["docker", "inspect", CONTAINER], check=True, capture_output=True, text=True).stdout
    )[0]
    validate_container_info(inspected)

    suffix = secrets.token_hex(6)
    first_database = f"knowledge_recovery_stage_{suffix}"
    proof_database = f"knowledge_recovery_proof_{suffix}"
    first_archive = f"/tmp/knowledge-recovery-{suffix}.dump"
    proof_archive = f"/tmp/knowledge-recovery-proof-{suffix}.dump"
    try:
        expected = canonical_counts(SOURCE_DATABASE)
        docker_postgres("pg_dump", "-U", "supabase_admin", "-d", SOURCE_DATABASE, "-Fc", "-f", first_archive)
        restore(first_database, first_archive)
        if canonical_counts(first_database) != expected:
            raise AssertionError("Canonical records, ACLs, bindings, or object references changed during restore")

        sql(first_database, """
BEGIN;
INSERT INTO knowledge.document(id,"companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification,"deletedAt")
VALUES('recovery-retired','company-a','alice','source-a','recovery-retired','Retired recovery document','alice','manual','withdrawn','internal',clock_timestamp()-interval '40 days');
INSERT INTO knowledge."documentVersion"(id,"companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus")
VALUES('recovery-retired-version','company-a','alice','recovery-retired','1','synthetic-recovery-hash','documents/recovery-retired.pdf','91','application/pdf',10,clock_timestamp()-interval '40 days','synthetic','ready');
UPDATE knowledge.document SET "currentVersionId"='recovery-retired-version',version=version+1 WHERE id='recovery-retired';
INSERT INTO knowledge.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,"tokenCount","embeddingProfile","indexGeneration")
VALUES('recovery-retired-chunk','company-a','alice','recovery-retired','recovery-retired-version',0,'retired recovery text',3,'synthetic',1);
COMMIT
""")
        verify_policy_and_rebuild_state(first_database)

        docker_postgres("pg_dump", "-U", "supabase_admin", "-d", first_database, "-Fc", "-f", proof_archive)
        restore(proof_database, proof_archive)
        verify_policy_and_rebuild_state(proof_database)
        print(json.dumps({"restored": True, "authorizationPreserved": True, "tombstonesPreserved": True, "rebuildableIndex": True}))
    finally:
        for database in (proof_database, first_database):
            subprocess.run(
                ["docker", "exec", "-e", f"PGPASSWORD={PASSWORD}", CONTAINER, "dropdb", "-U", "supabase_admin", "--if-exists", "--force", database],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        subprocess.run(
            ["docker", "exec", CONTAINER, "rm", "-f", first_archive, proof_archive],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )


if __name__ == "__main__":
    main()
