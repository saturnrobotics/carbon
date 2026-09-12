"""Hidden matches and inaccessible citations under the real read role.

`doc-hidden` shares the fixture's lexical term but lacks the source-origin grant,
so it must change no counts, snippets or version lookups for the reader.
"""
import unittest
from pathlib import Path

from test_schema import as_reader, sql


class HiddenResultTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql(Path(__file__).with_name("policy-fixtures.sql").read_text())

    def test_matching_hidden_manual_changes_no_counts_or_snippets(self):
        search = "SELECT id FROM knowledge.search_lexical('company-a',ARRAY['source-a'],'{term}',10) ORDER BY id"
        self.assertEqual(as_reader("alice", "company-a", search.format(term="manual")), ["chunk-doc-a"])
        hidden_only = as_reader("alice", "company-a", search.format(term="Hidden"))
        absent = as_reader("alice", "company-a", search.format(term="nonexistentterm"))
        self.assertEqual(hidden_only, [])
        self.assertEqual(hidden_only, absent)
        self.assertEqual(as_reader("alice", "company-a", "SELECT count(*) FROM knowledge.chunk WHERE \"documentId\" IN ('doc-a','doc-hidden','doc-b')"), ["1"])
        self.assertEqual(
            as_reader("alice", "company-a", "SELECT count(*) FROM knowledge.document WHERE id IN ('doc-a','doc-hidden','doc-b') AND title ILIKE '%manual%'"),
            ["1"],
        )
        self.assertEqual(
            as_reader("alice", "company-a", "SELECT count(*) FROM knowledge.chunk WHERE \"documentId\" IN ('doc-a','doc-hidden','doc-b') AND text ILIKE '%hidden%'"),
            ["0"],
        )

    def test_citation_to_an_inaccessible_version_resolves_nothing(self):
        version = "SELECT id FROM knowledge.\"documentVersion\" WHERE id='{id}'"
        self.assertEqual(as_reader("alice", "company-a", version.format(id="version-doc-a")), ["version-doc-a"])
        self.assertEqual(as_reader("alice", "company-a", version.format(id="version-doc-hidden")), [])
        self.assertEqual(as_reader("bob", "company-b", version.format(id="version-doc-a")), [])
        self.assertEqual(as_reader("revoked", "company-a", version.format(id="version-doc-a")), [])
        self.assertEqual(
            as_reader("alice", "company-a", "SELECT knowledge.can_access('company-a','source-a','doc-hidden',NULL,'read')"),
            ["f"],
        )
        self.assertEqual(
            as_reader("alice", "company-a", "SELECT knowledge.can_access('company-a','source-a','doc-a',NULL,'read')"),
            ["t"],
        )


if __name__ == "__main__":
    unittest.main()
