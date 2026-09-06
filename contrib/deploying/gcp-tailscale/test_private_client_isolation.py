"""Exercise real PostgreSQL permissions in an isolated disposable cluster.

Use local PostgreSQL binaries, or set CARBON_ISOLATION_TEST_IMAGE to a local
PostgreSQL Docker image. Neither mode connects to an existing database.
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid


POLICY = Path(__file__).with_name("private-client-isolation.sql").read_text()


class PrivateClientIsolationTest(unittest.TestCase):
    @classmethod
    def command(cls, *args, input=None, check=True):
        result = subprocess.run(
            args, input=input, text=True, capture_output=True,
            env=cls.environment, timeout=60,
        )
        if check and result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return result

    @classmethod
    def sql(cls, statement, *, database="isolation_test", role="postgres", check=True):
        return cls.command(
            *cls.psql, "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
            "-U", role, "-d", database, input=statement, check=check,
        )

    @classmethod
    def setUpClass(cls):
        cls.environment = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        cls.environment["LC_ALL"] = "C"
        cls.image = os.environ.get("CARBON_ISOLATION_TEST_IMAGE")
        if cls.image:
            cls.container = "carbon-isolation-" + uuid.uuid4().hex[:12]
            cls.command(
                "docker", "run", "-d", "--rm", "--network", "none",
                "--tmpfs", "/tmp:rw,mode=1777,size=256m",
                "--user", "postgres", "--name", cls.container,
                "--entrypoint", "/bin/sh", cls.image, "-ceu",
                "initdb -D /tmp/isolation-data --auth-local=trust --auth-host=reject "
                "--no-locale >/tmp/init.log; "
                "exec postgres -D /tmp/isolation-data -k /tmp -c listen_addresses='' -c fsync=off",
            )
            cls.addClassCleanup(cls.command, "docker", "rm", "-f", cls.container, check=False)
            cls.psql = ["docker", "exec", "-i", cls.container, "psql", "-h", "/tmp"]
            for _ in range(60):
                if cls.sql("SELECT 1", database="postgres", check=False).returncode == 0:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("Isolated PostgreSQL container did not become ready")
        else:
            for binary in ("initdb", "pg_ctl", "psql"):
                if not shutil.which(binary):
                    raise unittest.SkipTest("Install PostgreSQL or set CARBON_ISOLATION_TEST_IMAGE")
            cls.temporary = tempfile.TemporaryDirectory(prefix="carbon-isolation-", dir="/tmp")
            cls.addClassCleanup(cls.temporary.cleanup)
            cluster = Path(cls.temporary.name)
            cls.command("initdb", "-D", str(cluster / "data"), "-U", "postgres",
                        "--auth-local=trust", "--auth-host=reject", "--no-locale")
            cls.command("pg_ctl", "-D", str(cluster / "data"), "-l", str(cluster / "postgres.log"),
                        "-w", "start", "-o", f"-k {cluster} -c listen_addresses='' -c fsync=off")
            cls.addClassCleanup(cls.command, "pg_ctl", "-D", str(cluster / "data"),
                                "-m", "immediate", "-w", "stop", check=False)
            cls.psql = ["psql", "-h", str(cluster), "-p", "5432"]

    def setUp(self):
        self.sql("""
            CREATE ROLE isolation_app LOGIN NOINHERIT;
            CREATE ROLE isolation_migrator LOGIN NOINHERIT;
            CREATE ROLE isolation_carbon LOGIN NOINHERIT;
            CREATE DATABASE isolation_test;
        """, database="postgres")
        self.addCleanup(self.sql, """
            DROP DATABASE isolation_test WITH (FORCE);
            DROP ROLE isolation_app, isolation_migrator, isolation_carbon;
        """, database="postgres")
        self.sql("""
            CREATE SCHEMA carbon_private;
            CREATE TABLE carbon_private.database_clients (role_name TEXT PRIMARY KEY, schema_name TEXT NOT NULL);
            CREATE SCHEMA kanban AUTHORIZATION isolation_migrator;
            GRANT USAGE ON SCHEMA kanban TO isolation_app;
            INSERT INTO carbon_private.database_clients VALUES
              ('isolation_app', 'kanban'), ('isolation_migrator', 'kanban');
            CREATE SCHEMA net;
            GRANT USAGE ON SCHEMA net TO PUBLIC;
            GRANT CREATE ON SCHEMA public TO PUBLIC;
            CREATE TABLE public.private_data (value TEXT);
            INSERT INTO public.private_data VALUES ('synthetic');
            CREATE FUNCTION public.privileged_read() RETURNS TEXT
              LANGUAGE SQL SECURITY DEFINER SET search_path=public
              AS 'SELECT value FROM private_data LIMIT 1';
            CREATE FUNCTION net.privileged_read() RETURNS TEXT
              LANGUAGE SQL SECURITY DEFINER SET search_path=public
              AS 'SELECT value FROM private_data LIMIT 1';
            SET ROLE isolation_migrator;
            CREATE TABLE kanban.tickets (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
            GRANT SELECT, INSERT, UPDATE, DELETE ON kanban.tickets TO isolation_app;
            RESET ROLE;
        """)

    def test_private_client_cannot_call_definers_or_read_other_schemas(self):
        self.assertEqual(self.sql("SELECT public.privileged_read()", role="isolation_app").stdout.strip(), "synthetic")
        self.sql(POLICY)
        for role in ("isolation_app", "isolation_migrator"):
            for query in ("SELECT public.privileged_read()", "SELECT net.privileged_read()",
                          "SELECT * FROM public.private_data", "SELECT * FROM carbon_private.database_clients",
                          "CREATE TEMP TABLE shadow (id INTEGER)", "CREATE TABLE public.shadow (id INTEGER)",
                          "CREATE SCHEMA unauthorized", "SET ROLE isolation_carbon"):
                with self.subTest(role=role, query=query):
                    self.assertNotEqual(self.sql(query, role=role, check=False).returncode, 0)
        self.sql("INSERT INTO kanban.tickets VALUES (1, 'synthetic'); UPDATE kanban.tickets SET title='updated' WHERE id=1;",
                 role="isolation_app")
        self.assertEqual(self.sql("SELECT title FROM kanban.tickets", role="isolation_app").stdout.strip(), "updated")
        self.sql("ALTER TABLE kanban.tickets ADD COLUMN details TEXT", role="isolation_migrator")

    def test_existing_service_permissions_survive_and_policy_is_idempotent(self):
        self.sql(POLICY)
        self.sql(POLICY)
        self.assertEqual(self.sql("SELECT public.privileged_read(); SELECT net.privileged_read();",
                                  role="isolation_carbon").stdout.strip(), "synthetic\nsynthetic")
        self.sql("CREATE TEMP TABLE existing_service_temp (id INTEGER); CREATE TABLE public.service_table(id INTEGER);",
                 role="isolation_carbon")
        self.assertEqual(self.sql("SELECT has_schema_privilege('pg_monitor', 'public', 'USAGE')").stdout.strip(), "f")

    def test_public_grant_reintroduced_by_upgrade_is_removed(self):
        self.sql(POLICY)
        self.sql("GRANT USAGE ON SCHEMA public, net TO PUBLIC; GRANT TEMPORARY ON DATABASE isolation_test TO PUBLIC;")
        self.sql(POLICY)
        self.assertNotEqual(self.sql("SELECT public.privileged_read()", role="isolation_app", check=False).returncode, 0)

    def test_explicit_cross_schema_grant_is_rejected_atomically(self):
        self.sql("GRANT USAGE ON SCHEMA net TO isolation_app")
        self.assertNotEqual(self.sql(POLICY, check=False).returncode, 0)
        self.assertEqual(self.sql("SELECT has_schema_privilege('isolation_migrator','public','USAGE')").stdout.strip(), "t")

    def test_privileged_or_member_client_is_rejected(self):
        for grant, revoke in (("ALTER ROLE isolation_app BYPASSRLS", "ALTER ROLE isolation_app NOBYPASSRLS"),
                             ("GRANT isolation_carbon TO isolation_app", "REVOKE isolation_carbon FROM isolation_app"),
                             ("ALTER ROLE isolation_app INHERIT", "ALTER ROLE isolation_app NOINHERIT")):
            with self.subTest(grant=grant):
                self.sql(grant)
                self.assertNotEqual(self.sql(POLICY, check=False).returncode, 0)
                self.sql(revoke)

    def test_explicit_database_or_system_schema_creation_is_rejected(self):
        for grant, revoke in (("GRANT CREATE ON SCHEMA pg_catalog TO isolation_app",
                               "REVOKE CREATE ON SCHEMA pg_catalog FROM isolation_app"),
                              ("GRANT TEMPORARY ON DATABASE isolation_test TO isolation_app",
                               "REVOKE TEMPORARY ON DATABASE isolation_test FROM isolation_app")):
            with self.subTest(grant=grant):
                self.sql(grant)
                self.assertNotEqual(self.sql(POLICY, check=False).returncode, 0)
                self.sql(revoke)

    def test_absent_or_empty_registry_does_not_change_permissions(self):
        self.sql("DELETE FROM carbon_private.database_clients")
        self.sql(POLICY)
        self.sql("DROP TABLE carbon_private.database_clients")
        self.sql(POLICY)
        self.assertEqual(self.sql("SELECT public.privileged_read()", role="isolation_app").stdout.strip(), "synthetic")


if __name__ == "__main__":
    unittest.main()
