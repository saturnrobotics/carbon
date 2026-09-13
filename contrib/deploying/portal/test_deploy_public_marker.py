"""Observe an exact function marker without application-schema privileges."""
from contextlib import closing
import sqlite3
import unittest

from test_deploy import module


class PublicMarkerTests(unittest.TestCase):
    def observe(self, functions):
        deploy = module()
        with closing(sqlite3.connect(":memory:")) as catalog:
            catalog.execute("ATTACH DATABASE ':memory:' AS pg_catalog")
            catalog.execute("CREATE TABLE pg_catalog.pg_namespace (oid INTEGER, nspname TEXT)")
            catalog.executemany("INSERT INTO pg_catalog.pg_namespace VALUES (?, ?)", [(1, "public"), (2, "other")])
            catalog.execute("CREATE TABLE pg_catalog.pg_proc (pronamespace INTEGER, proname TEXT, pronargs INTEGER, proargtypes TEXT, prokind TEXT)")
            catalog.executemany("INSERT INTO pg_catalog.pg_proc VALUES (?, ?, ?, ?, ?)", functions)
            case = self

            class CatalogReader:
                def call(self, args, *, capture=False):
                    case.assertEqual(args[0], "psql")
                    case.assertTrue(capture)
                    case.assertIn("service=synthetic-observer", args)
                    sql = args[-1]
                    case.assertNotIn("to_regprocedure", sql, "Name resolution requires application-schema USAGE")
                    case.assertTrue(sql.lstrip().startswith("SELECT EXISTS"))
                    # SQLite represents the catalog's oidvector as its text
                    # form; only PostgreSQL's type annotation differs here.
                    result = catalog.execute(sql.replace("::pg_catalog.oidvector", "")).fetchone()[0]
                    return "t" if result else "f"

            deploy.require_public_schema({"pg_service": "synthetic-observer"}, CatalogReader())

    def test_observer_without_public_schema_usage_can_find_exact_function(self):
        self.observe([(1, "portal_resolve_workforce_identity", 3, "25 25 25", "f")])

    def test_lookalike_function_cannot_satisfy_required_migration(self):
        marker = "portal_resolve_workforce_identity"
        cases = [[], [(2, marker, 3, "25 25 25", "f")],
                 [(1, marker, 2, "25 25", "f")], [(1, marker, 3, "25 25 23", "f")],
                 [(1, marker, 3, "25 25 25", "p")], [(1, "other_function", 3, "25 25 25", "f")]]
        for functions in cases:
            with self.subTest(functions=functions):
                with self.assertRaisesRegex(ValueError, "Apply the Carbon Portal public-identifiers migration"):
                    self.observe(functions)


if __name__ == "__main__":
    unittest.main()
