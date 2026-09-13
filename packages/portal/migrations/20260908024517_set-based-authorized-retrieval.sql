-- Rank only after one current-identity check and a set-based ACL intersection.
-- These functions are the read role's narrow retrieval surface; base-table RLS
-- remains authoritative for all other reads.
SET LOCAL ROLE knowledge_migrate;

CREATE INDEX IF NOT EXISTS grant_active_document_subject_idx
  ON knowledge."grant" ("companyId","sourceId","documentId",origin,"subjectKind","subjectId",capability)
  WHERE "revokedAt" IS NULL;
CREATE INDEX IF NOT EXISTS group_membership_active_actor_idx
  ON knowledge."groupMembership" ("companyId","memberUserId",origin,"sourceId","groupId")
  WHERE "revokedAt" IS NULL;

CREATE OR REPLACE FUNCTION knowledge.search_lexical(
  p_company text,
  p_source_ids text[],
  p_query text,
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
    OR p_query IS NULL OR btrim(p_query)='' OR length(p_query)>8000
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'Invalid authorized lexical search';
  END IF;

  RETURN QUERY
  WITH allowed_documents AS MATERIALIZED (
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
  )
  SELECT c.id,d.id,c."documentVersionId",d."sourceId",d.kind,d."sourceRevision",d."sourceItemId",
    c.text,d.title,c.heading,c.page,c."tokenCount",d.classification,d."providerPolicy",d."aclVersion",
    to_char(d."observedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM knowledge.chunk c
  JOIN allowed_documents d ON d.id=c."documentId" AND d."currentVersionId"=c."documentVersionId"
  WHERE c."companyId"=p_company AND c.fts @@ websearch_to_tsquery('english',p_query)
  ORDER BY ts_rank_cd(c.fts,websearch_to_tsquery('english',p_query)) DESC,c.id
  LIMIT p_limit;
END $$;

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

CREATE OR REPLACE FUNCTION knowledge.can_access(company text, source_id text, doc_id text DEFAULT NULL, entity_id text DEFAULT NULL, requested text DEFAULT 'read') RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT knowledge.actor_active(company) AND EXISTS (
  SELECT 1 FROM knowledge.source s WHERE s.id=source_id AND s."companyId"=company AND s.status='active'
   AND knowledge.has_grant(company,source_id,doc_id,entity_id,requested,'local')
   AND (s.kind='upload' OR (
    EXISTS (SELECT 1 FROM knowledge."sourceUserBinding" b
      WHERE b."companyId"=company AND b."sourceId"=source_id
       AND b."canonicalUserId"=knowledge.actor_id() AND b.active)
    AND knowledge.has_grant(company,source_id,doc_id,entity_id,'read','source')
   ))
 )
$$;

REVOKE ALL ON FUNCTION knowledge.search_lexical(text,text[],text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION knowledge.search_vector_exact(text,text[],text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION knowledge.search_lexical(text,text[],text,integer) TO knowledge_read;
GRANT EXECUTE ON FUNCTION knowledge.search_vector_exact(text,text[],text,text,integer) TO knowledge_read;

RESET ROLE;
