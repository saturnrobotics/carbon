# Knowledge retrieval gaps: extension record, section expansion, filtered ANN

**Date:** 2026-09-11
**Scope:** Task 16 of the company knowledge platform plan (§1.7), remaining gaps.
**Base revision:** `feat/knowledge-authz-10-provider-policy` at `2dee38be02`.

## Decisions

- **Extension versions are recorded, not assumed.** Migration
  `20260911210001_record-extension-versions.sql` creates the non-tenant table
  `knowledge."extensionVersion"` (owner-only, no row policies, listed in
  `KNOWLEDGE_METADATA_TABLES`) and records pgvector's `extversion` at migration
  time. `verifyKnowledgeExtensions` runs after every migration pass: a missing or
  below-minimum extension refuses to start; a changed version is re-recorded as
  `startup` and reported by `scripts/migrate.ts`, so a Postgres image bump is
  visible instead of silently changing recall.
- **One ACL predicate for every vector ranking.** `knowledge.search_allowed_documents`
  holds the predicate; `search_vector_exact` was re-created on top of it and
  `search_vector_ann` filters the HNSW scan with the same set, so a recall
  comparison between them measures approximation only. `search_lexical` was left
  as it was. The helper is executable by no runtime role.
- **The database picks the vector path and says so.** `search_vector_ann` runs an
  iterative HNSW scan (`hnsw.iterative_scan = relaxed_order`, `hnsw.ef_search = 200`,
  both transaction-local) when the installed pgvector is at least 0.8.0 and
  returns `retrievalPath = 'vector-ann'`; otherwise it returns the exact baseline
  as `'vector-exact'`. `Evidence` carries an optional `retrievalPath`
  (`lexical` / `vector-exact` / `vector-ann`), an additive contract change.
- **Parent-section expansion never displaces a hit.** `planSectionExpansion` orders
  selected chunks first, then parents by rank, then grandparents, de-duplicated,
  and `assembleEvidence` applies the unchanged eight-block and token caps.
  Lineage comes from `loadParentSections` (recursive CTE, depth 3, same document
  version and embedding profile) under the reader's base-table policies; the
  query app live-checks each section before delivery. The manual-v1 path is
  untouched: it delivers a resolved manual's first chunk, not fused hits.

## Measurement

`measureFilteredRecall` (`retrieval/recall.ts`) builds 2000 random 768-d chunks
under one reader granted 10% of the documents, inside one rolled-back
transaction, with `enable_seqscan` and `enable_sort` off so the index path is
what runs (verified by `EXPLAIN`, reported as `usesIndex`). Against
`search_vector_exact`, recall@10 over 20 queries:

| Setting | recall@10 |
| --- | --- |
| `search_vector_ann` (iterative, ef_search 200) | 0.995–1.00 across runs (HNSW builds are not bit-deterministic) |
| iterative, ef_search 120 / 80 / 40 | 0.965 / 0.945 / 0.92 |
| pgvector defaults (iterative off, ef_search 40), same filter | 0.385 |

The first measurement reported 1.0 for both paths because the planner had chosen
a sequential scan at that corpus size; a 20,000-document fixture took ~400 s to
build and still scanned sequentially. The `usesIndex` check is what makes the
number mean something.

## Verification

- `pnpm --filter @carbon/knowledge migrate:test` — applied, `vector 0.8.0` recorded.
- `pnpm --filter @carbon/knowledge generate:types` — 17 tables.
- `pnpm --filter @carbon/knowledge test:integration retrieval` — 22 passed.
- `pnpm --filter @carbon/knowledge test retrieval recall` — 14 passed; full suite 130.
- `pnpm --filter knowledge-query test` — 29 passed.
- `python3 packages/knowledge/scripts/test_schema.py` — 20 passed.
- `pnpm exec turbo run typecheck --filter=@carbon/knowledge --filter=knowledge-query` — clean.
- Root `pnpm run generate:types` not run: no Carbon development database was
  running, and the knowledge migration changes no public type.
