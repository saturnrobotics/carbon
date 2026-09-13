# UPDATE … RETURNING does not preserve the locking query's order

Context → The knowledge outbox claim leased rows with `SELECT … ORDER BY priority FOR UPDATE SKIP LOCKED LIMIT n` in a CTE, then `UPDATE … WHERE id IN (SELECT id FROM cte) RETURNING …`. Consumers iterated the returned rows believing revocations came first. An integration test that delivered a revocation behind a correction showed the returned order was arbitrary.

Problem → The `ORDER BY` in a locking CTE only decides which rows fit under the `LIMIT`. PostgreSQL gives no ordering guarantee for `UPDATE … RETURNING`, so "prioritise revocations" was true of selection and false of processing, and no unit test could see it because the fake pool echoed the input order.

Rule → When the processing order of claimed rows matters, carry it explicitly: compute a `row_number()` ordinal over the locked rows in a second CTE, return it from the `UPDATE … FROM`, and sort on it before handing rows to callers. Assert the order in an integration test against the real database, not a recording fake.

Applies to → Outbox and queue claim queries, any `UPDATE`/`DELETE … RETURNING` whose result feeds an ordered loop, and tests that claim priority semantics.
