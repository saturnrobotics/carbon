## Prove the index path ran before trusting an ANN recall number

**Context:** Measuring filtered pgvector HNSW recall against the exact authorized baseline on a synthetic corpus small enough for a test.

**Problem:** The first run reported recall@10 = 1.0 for both the approximate and the post-filtered path. The planner had chosen a sequential scan and sort for the calibration statement, so both "paths" were the exact query; the number proved nothing. Growing the corpus tenfold did not change the plan and took minutes to build.

**Rule:** A recall measurement must record which plan ran (`EXPLAIN`, an index-name check) and assert it, and it should include a negative control that is expected to be worse. When the planner will not choose the index at calibration size, disable the alternatives for that transaction only and say so; never conclude from a perfect score alone.

**Applies to:** Any approximate-search calibration, filtered ANN tuning, and tests that compare an optimized path with a baseline.
