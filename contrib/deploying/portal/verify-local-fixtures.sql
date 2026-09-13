-- Post-suite assertion for the disposable browser fixture, not a migration.
-- psql --set=preserve=1 requires both an uploaded original and a tombstone;
-- preserve=0 requires this run's captured upload fixtures to have been cleaned.
-- "before" contains pre-suite IDs, so explicitly retained earlier runs survive.
\set ON_ERROR_STOP on
\if :{?before}
\else
\set before '{"intakes":[],"documents":[]}'
\endif
\if :preserve
SELECT
  EXISTS (
    SELECT 1 FROM portal.document d
    JOIN portal."documentVersion" v
      ON v."documentId" = d.id AND v."companyId" = d."companyId"
    WHERE d."companyId" = 'company-b' AND d."sourceId" = 'source-b'
      AND d."sourceItemId" LIKE 'intake:%'
      AND d.id NOT IN (SELECT jsonb_array_elements_text(:'before'::jsonb -> 'documents'))
      AND d.status = 'published' AND d."deletedAt" IS NULL
      AND v.id = d."currentVersionId"
      AND v."objectKey" <> '' AND v."objectGeneration" <> ''
  ) AND EXISTS (
    SELECT 1 FROM portal.document
    WHERE "companyId" = 'company-b' AND "sourceId" = 'source-b'
      AND "sourceItemId" LIKE 'intake:%' AND "deletedAt" IS NOT NULL
      AND id NOT IN (SELECT jsonb_array_elements_text(:'before'::jsonb -> 'documents'))
  ) AS fixture_valid
\gset
\else
SELECT
  NOT EXISTS (
    SELECT 1 FROM portal.intake WHERE "companyId" = 'company-b'
      AND id NOT IN (SELECT jsonb_array_elements_text(:'before'::jsonb -> 'intakes'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM portal.document
    WHERE "companyId" = 'company-b' AND "sourceId" = 'source-b'
      AND "sourceItemId" LIKE 'intake:%'
      AND id NOT IN (SELECT jsonb_array_elements_text(:'before'::jsonb -> 'documents'))
  ) AS fixture_valid
\gset
\endif
\if :fixture_valid
\echo Browser fixture preservation/cleanup verified.
\else
DO $fixture$
BEGIN
  RAISE EXCEPTION 'Browser fixture preservation/cleanup failed; do not use this run for recovery or performance evidence';
END
$fixture$;
\endif
