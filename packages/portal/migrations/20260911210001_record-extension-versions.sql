-- Independently applied knowledge migration.
-- Records the extension versions the retrieval functions rely on, shares one
-- authorized-document predicate between exact and approximate vector search,
-- and adds the filtered HNSW path that enables pgvector iterative index scans
-- when the installed version supports them.
SET LOCAL ROLE knowledge_migrate;

-- Non-tenant metadata: which extension versions the search functions were
-- written against. Written here and re-checked by migrations.server.ts so a
-- version change is visible rather than silently altering recall.
CREATE TABLE IF NOT EXISTS knowledge."extensionVersion" (
  name text PRIMARY KEY CHECK (name ~ '^[a-z_]{1,63}$'),
  version text NOT NULL CHECK (version ~ '^[0-9]+(\.[0-9]+)*$'),
  "recordedBy" text NOT NULL CHECK (length("recordedBy") BETWEEN 1 AND 200),
  "recordedAt" timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON knowledge."extensionVersion" FROM PUBLIC, anon, authenticated;

INSERT INTO knowledge."extensionVersion"(name,version,"recordedBy")
SELECT e.extname,e.extversion,'20260911210001_record-extension-versions'
FROM pg_catalog.pg_extension e WHERE e.extname='vector'
ON CONFLICT (name) DO UPDATE SET version=EXCLUDED.version,"recordedBy"=EXCLUDED."recordedBy","recordedAt"=now();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM knowledge."extensionVersion" WHERE name='vector') THEN
    RAISE EXCEPTION 'pgvector must be installed before knowledge retrieval migrations';
  END IF;
END $$;

-- Live version gate for optional index features. Reads the catalogue, never
-- the recorded row, so a re-installed extension changes behaviour immediately.
CREATE OR REPLACE FUNCTION knowledge.extension_at_least(p_name text, p_version text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  SELECT coalesce((
    SELECT e.extversion ~ '^[0-9]+(\.[0-9]+)*$'
      AND pg_catalog.string_to_array(e.extversion,'.')::int[] >= pg_catalog.string_to_array(p_version,'.')::int[]
    FROM pg_catalog.pg_extension e WHERE e.extname=p_name
  ),false)
$$;
REVOKE ALL ON FUNCTION knowledge.extension_at_least(text,text) FROM PUBLIC,anon,authenticated;

-- The one ACL predicate every vector ranking applies. Callers validate the
-- current identity and bounds first; this helper is not runtime-executable.
CREATE OR REPLACE FUNCTION knowledge.search_allowed_documents(
  p_company text,
  p_source_ids text[]
) RETURNS TABLE (
  id text,
  "currentVersionId" text,
  "sourceId" text,
  "sourceItemId" text,
  title text,
  classification text,
  "aclVersion" bigint,
  kind text,
  "providerPolicy" jsonb,
  "sourceRevision" text,
  "observedAt" timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT d.id,d."currentVersionId",d."sourceId",d."sourceItemId",d.title,
    d.classification,d."aclVersion",s.kind,s."providerPolicy",v."sourceRevision",v."observedAt"
  FROM knowledge.document d
  JOIN knowledge.source s ON s.id=d."sourceId" AND s."companyId"=d."companyId"
  JOIN knowledge."documentVersion" v ON v.id=d."currentVersionId" AND v."documentId"=d.id AND v."companyId"=d."companyId"
  WHERE d."companyId"=p_company AND d."sourceId"=ANY(p_source_ids)
    AND d.status='published' AND d."deletedAt" IS NULL AND s.status='active' AND v."extractionStatus"='ready'
    AND EXISTS (
      SELECT 1 FROM knowledge."grant" g
      WHERE g."companyId"=p_company AND g."sourceId"=d."sourceId" AND g.origin='local'
        AND g."revokedAt" IS NULL AND (g."validUntil" IS NULL OR g."validUntil">now())
        AND g.capability IN ('read','admin')
        AND ((g."documentId" IS NULL AND g."entityId" IS NULL) OR g."documentId"=d.id)
        AND ((g."subjectKind"='user' AND g."subjectId"=knowledge.actor_id()) OR
          (g."subjectKind"='group' AND EXISTS (
            SELECT 1 FROM knowledge."groupMembership" m
            WHERE m."companyId"=p_company AND m."memberUserId"=knowledge.actor_id()
              AND m."groupId"=g."subjectId" AND m.origin='local'
              AND (m."sourceId" IS NULL OR m."sourceId"=d."sourceId")
              AND m."revokedAt" IS NULL AND m."validUntil">now()
          )))
    )
    AND (s.kind='upload' OR (
      EXISTS (
        SELECT 1 FROM knowledge."sourceUserBinding" b
        WHERE b."companyId"=p_company AND b."sourceId"=d."sourceId"
          AND b."canonicalUserId"=knowledge.actor_id() AND b.active
      )
      AND EXISTS (
        SELECT 1 FROM knowledge."grant" g
        WHERE g."companyId"=p_company AND g."sourceId"=d."sourceId" AND g.origin='source'
          AND g."revokedAt" IS NULL AND (g."validUntil" IS NULL OR g."validUntil">now())
          AND g.capability IN ('read','admin')
          AND ((g."documentId" IS NULL AND g."entityId" IS NULL) OR g."documentId"=d.id)
          AND ((g."subjectKind"='user' AND g."subjectId"=knowledge.actor_id()) OR
            (g."subjectKind"='group' AND EXISTS (
              SELECT 1 FROM knowledge."groupMembership" m
              WHERE m."companyId"=p_company AND m."memberUserId"=knowledge.actor_id()
                AND m."groupId"=g."subjectId" AND m.origin='source' AND m."sourceId"=d."sourceId"
                AND m."revokedAt" IS NULL AND m."validUntil">now()
            )))
      )
    ))
$$;
REVOKE ALL ON FUNCTION knowledge.search_allowed_documents(text,text[]) FROM PUBLIC,anon,authenticated;

-- Exact baseline, unchanged in behaviour, now sharing the predicate above so a
-- recall comparison against the approximate path measures only approximation.
CREATE OR REPLACE FUNCTION knowledge.search_vector_exact(
  p_company text,
  p_source_ids text[],
  p_profile text,
  p_embedding text,
  p_limit integer
) RETURNS TABLE (
  id text,
  "documentId" text,
  "documentVersionId" text,
  "sourceId" text,
  "sourceKind" text,
  "sourceRevision" text,
  "sourceItemId" text,
  text text,
  title text,
  heading text,
  page integer,
  "tokenCount" integer,
  classification text,
  "providerPolicy" jsonb,
  "aclVersion" bigint,
  "observedAt" text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_company IS NULL OR p_company IS DISTINCT FROM knowledge.company_id()
    OR knowledge.actor_id() IS NULL
    OR NOT knowledge.actor_active(p_company)
    OR p_source_ids IS NULL
    OR cardinality(p_source_ids) NOT BETWEEN 1 AND 4
    OR array_position(p_source_ids,NULL) IS NOT NULL
    OR p_profile IS NULL OR btrim(p_profile)='' OR length(p_profile)>8000
    OR p_embedding IS NULL OR octet_length(p_embedding)>100000
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'Invalid authorized vector search';
  END IF;

  RETURN QUERY
  WITH allowed_documents AS MATERIALIZED (
    SELECT * FROM knowledge.search_allowed_documents(p_company,p_source_ids)
  ), candidates AS MATERIALIZED (
    SELECT c.id,d.id AS "documentId",c."documentVersionId",d."sourceId",d.kind AS "sourceKind",
      d."sourceRevision",d."sourceItemId",c.text,d.title,c.heading,c.page,c."tokenCount",d.classification,
      d."providerPolicy",d."aclVersion",d."observedAt",c.embedding
    FROM allowed_documents d
    JOIN knowledge.chunk c ON c."companyId"=p_company AND c."documentId"=d.id
      AND c."documentVersionId"=d."currentVersionId"
    WHERE c."embeddingProfile"=p_profile AND c.embedding IS NOT NULL
  )
  SELECT c.id,c."documentId",c."documentVersionId",c."sourceId",c."sourceKind",c."sourceRevision",c."sourceItemId",
    c.text,c.title,c.heading,c.page,c."tokenCount",c.classification,c."providerPolicy",c."aclVersion",
    to_char(c."observedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM candidates c
  ORDER BY c.embedding OPERATOR(extensions.<=>) p_embedding::extensions.vector(768),c.id
  LIMIT p_limit;
END $$;

-- Filtered approximate search. The ACL predicate is applied as an index-scan
-- filter, never after candidate selection: with pgvector >= 0.8.0 the HNSW
-- scan continues (iterative, relaxed order) until enough authorized rows are
-- found. Older installs cannot do that, and a post-filtered scan loses recall
-- under selective ACLs, so they take the exact baseline. The chosen path is
-- returned with every row so evidence can record it.
CREATE OR REPLACE FUNCTION knowledge.search_vector_ann(
  p_company text,
  p_source_ids text[],
  p_profile text,
  p_embedding text,
  p_limit integer
) RETURNS TABLE (
  id text,
  "documentId" text,
  "documentVersionId" text,
  "sourceId" text,
  "sourceKind" text,
  "sourceRevision" text,
  "sourceItemId" text,
  text text,
  title text,
  heading text,
  page integer,
  "tokenCount" integer,
  classification text,
  "providerPolicy" jsonb,
  "aclVersion" bigint,
  "observedAt" text,
  "retrievalPath" text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_versions text[];
BEGIN
  IF p_company IS NULL OR p_company IS DISTINCT FROM knowledge.company_id()
    OR knowledge.actor_id() IS NULL
    OR NOT knowledge.actor_active(p_company)
    OR p_source_ids IS NULL
    OR cardinality(p_source_ids) NOT BETWEEN 1 AND 4
    OR array_position(p_source_ids,NULL) IS NOT NULL
    OR p_profile IS NULL OR btrim(p_profile)='' OR length(p_profile)>8000
    OR p_embedding IS NULL OR octet_length(p_embedding)>100000
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'Invalid authorized vector search';
  END IF;

  IF NOT knowledge.extension_at_least('vector','0.8.0') THEN
    RETURN QUERY
    SELECT e.*,'vector-exact'::text
    FROM knowledge.search_vector_exact(p_company,p_source_ids,p_profile,p_embedding,p_limit) e;
    RETURN;
  END IF;

  SELECT pg_catalog.array_agg(a."currentVersionId") INTO v_versions
  FROM knowledge.search_allowed_documents(p_company,p_source_ids) a;
  IF v_versions IS NULL THEN
    RETURN;
  END IF;

  -- Transaction-local, so no session default is relied on. ef_search was
  -- calibrated by retrieval/recall.ts on 2000 random 768-d chunks at 10% ACL
  -- selectivity: recall@10 0.92 at 40 (the pgvector default), 0.945 at 80,
  -- 0.965 at 120, 1.0 at 200 — 200 keeps a margin over the 0.95 floor (A07).
  PERFORM pg_catalog.set_config('hnsw.iterative_scan','relaxed_order',true),
    pg_catalog.set_config('hnsw.ef_search','200',true);
  RETURN QUERY
  WITH ranked AS MATERIALIZED (
    SELECT c.id,c."documentId",c."documentVersionId",c.text,c.heading,c.page,c."tokenCount",
      c.embedding OPERATOR(extensions.<=>) p_embedding::extensions.vector(768) AS distance
    FROM knowledge.chunk c
    WHERE c."companyId"=p_company AND c."embeddingProfile"=p_profile AND c.embedding IS NOT NULL
      AND c."documentVersionId"=ANY(v_versions)
    ORDER BY c.embedding OPERATOR(extensions.<=>) p_embedding::extensions.vector(768)
    LIMIT p_limit
  )
  SELECT r.id,r."documentId",r."documentVersionId",d."sourceId",s.kind,v."sourceRevision",d."sourceItemId",
    r.text,d.title,r.heading,r.page,r."tokenCount",d.classification,s."providerPolicy",d."aclVersion",
    to_char(v."observedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'vector-ann'::text
  FROM ranked r
  JOIN knowledge.document d ON d.id=r."documentId" AND d."companyId"=p_company
  JOIN knowledge.source s ON s.id=d."sourceId" AND s."companyId"=p_company
  JOIN knowledge."documentVersion" v ON v.id=r."documentVersionId" AND v."documentId"=d.id AND v."companyId"=p_company
  ORDER BY r.distance,r.id;
END $$;

REVOKE ALL ON FUNCTION knowledge.search_vector_exact(text,text[],text,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION knowledge.search_vector_ann(text,text[],text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION knowledge.search_vector_exact(text,text[],text,text,integer) TO knowledge_read;
GRANT EXECUTE ON FUNCTION knowledge.search_vector_ann(text,text[],text,text,integer) TO knowledge_read;

RESET ROLE;
