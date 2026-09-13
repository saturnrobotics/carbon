SET LOCAL ROLE knowledge_migrate;
CREATE OR REPLACE FUNCTION knowledge.source_visible(company text, source_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT knowledge.can_access(company,source_id)
 OR EXISTS (SELECT 1 FROM knowledge.document d WHERE d."companyId"=company AND d."sourceId"=source_id
  AND knowledge.document_visible(company,d.id))
 OR EXISTS (SELECT 1 FROM knowledge.entity e WHERE e."companyId"=company AND e."sourceId"=source_id
  AND knowledge.entity_visible(company,e.id))
$$;
REVOKE ALL ON FUNCTION knowledge.source_visible(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION knowledge.source_visible(text,text) TO knowledge_read,knowledge_review;
DROP POLICY "SELECT" ON knowledge.source;
CREATE POLICY "SELECT" ON knowledge.source FOR SELECT USING (
 current_user='knowledge_migrate'
 OR (pg_has_role(current_user,'knowledge_read','member') AND knowledge.source_visible("companyId",id))
 OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId",id))
 OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.source_visible("companyId",id))
);
-- Exact authorized retrieval remains the baseline until filtered ANN recall is
-- measured for the deployed corpus/profile. This index does not bypass RLS.
CREATE INDEX IF NOT EXISTS chunk_embedding_cosine_idx ON knowledge.chunk
 USING hnsw (embedding extensions.vector_cosine_ops) WHERE embedding IS NOT NULL;
RESET ROLE;
