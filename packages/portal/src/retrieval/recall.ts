import type { PoolClient } from "pg";
import {
  PORTAL_EMBEDDING_DIMENSIONS,
  supportsIterativeScan
} from "../schema-contract";
import type { RetrievalPath } from "./lexical.server";

/** Below this, filtered approximate search must not replace the exact baseline (A07). */
export const RECALL_AT_10_THRESHOLD = 0.95;

export const RECALL_CALIBRATION = {
  documents: 2000,
  /** Fraction of documents the calibration reader is granted. */
  selectivity: 0.1,
  queries: 20,
  k: 10,
  seed: 0.42
} as const;

export type RecallMeasurement = {
  k: number;
  queries: number;
  documents: number;
  authorizedDocuments: number;
  selectivity: number;
  vectorVersion: string;
  iterativeScan: boolean;
  /** portal.search_vector_ann against portal.search_vector_exact. */
  ann: { recallAtK: number; path: RetrievalPath | null; usesIndex: boolean };
  /**
   * The same filter at pgvector's defaults (`hnsw.iterative_scan = off`,
   * `hnsw.ef_search = 40`): the index stops after ef_search candidates and
   * the ACL filter discards most of them. This is the failure mode the
   * function's tuned settings and the exact fallback exist for; it is
   * measured so the calibration proves it can tell the two apart.
   */
  postFiltered: { recallAtK: number; usesIndex: boolean };
};

const PGVECTOR_DEFAULT_EF_SEARCH = 40;

export function recallAtK(
  expected: readonly string[],
  actual: readonly string[],
  k: number
): number {
  if (!Number.isInteger(k) || k < 1) throw new Error("Invalid recall cutoff");
  const relevant = new Set(expected.slice(0, k));
  if (relevant.size === 0) return 1;
  let hits = 0;
  for (const id of new Set(actual.slice(0, k))) if (relevant.has(id)) hits += 1;
  return hits / relevant.size;
}

/** The runtime rule: the index path is trusted only with iterative scans AND calibrated recall. */
export function selectVectorPath(
  measurement: Pick<RecallMeasurement, "iterativeScan" | "ann">
): "ann" | "exact" {
  return measurement.iterativeScan &&
    measurement.ann.usesIndex &&
    measurement.ann.recallAtK >= RECALL_AT_10_THRESHOLD
    ? "ann"
    : "exact";
}

const companyId = "recall-company";
const readerId = "recall_reader";
const sourceId = "recall_source";
const profile = "recall-calibration-768";

/** Identical to the ranking statement inside portal.search_vector_ann. */
const annStatement = `SELECT c.id FROM portal.chunk c
  WHERE c."companyId"=$1 AND c."embeddingProfile"=$2 AND c.embedding IS NOT NULL
    AND c."documentVersionId"=ANY($3::text[])
  ORDER BY c.embedding OPERATOR(extensions.<=>) $4::extensions.vector(768)
  LIMIT $5`;

function planUsesIndex(plan: unknown): boolean {
  if (!plan || typeof plan !== "object") return false;
  const node = plan as Record<string, unknown>;
  if (node["Index Name"] === "chunk_embedding_cosine_idx") return true;
  return (
    Array.isArray(node.Plans) &&
    node.Plans.some((child) => planUsesIndex(child))
  );
}

function vectorText(values: readonly string[]) {
  return values.map((value) => `[${value}]`);
}

/**
 * Measure filtered-ANN recall against the exact authorized baseline on
 * synthetic data, inside ONE transaction that is always rolled back.
 *
 * `client` must be the disposable database's administrative connection: the
 * fixture is written under forced row security, and the reader's searches
 * run through `SET LOCAL ROLE portal_read` inside savepoints on the same
 * connection so uncommitted fixture rows are visible to them. Nothing survives
 * the call.
 */
export async function measureFilteredRecall(
  client: PoolClient,
  options: Partial<typeof RECALL_CALIBRATION> = {}
): Promise<RecallMeasurement> {
  const settings = { ...RECALL_CALIBRATION, ...options };
  if (
    !Number.isInteger(settings.documents) ||
    settings.documents < 100 ||
    settings.documents > 20_000 ||
    !(settings.selectivity > 0 && settings.selectivity <= 1) ||
    !Number.isInteger(settings.queries) ||
    settings.queries < 1 ||
    settings.queries > 200 ||
    !Number.isInteger(settings.k) ||
    settings.k < 1 ||
    settings.k > 40
  )
    throw new Error("Invalid recall calibration");
  const every = Math.max(1, Math.round(1 / settings.selectivity));
  await client.query("BEGIN");
  try {
    const version = await client.query<{ version: string }>(
      "SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname='vector'"
    );
    const vectorVersion = version.rows[0]?.version;
    if (!vectorVersion) throw new Error("pgvector is not installed");
    await client.query("SELECT setseed($1)", [settings.seed]);
    await installRecallFixture(client, settings.documents, every);
    // The measurement is of the index path itself. At calibration size the
    // planner would rather scan and sort — exact, and proving nothing — so
    // both are disabled for this transaction only; `usesIndex` below verifies
    // the plan that actually ran.
    await client.query(
      "SET LOCAL enable_seqscan=off; SET LOCAL enable_sort=off"
    );
    const queries = await client.query<{ embedding: string }>(
      `SELECT (SELECT string_agg((random()-0.5)::text,',') FROM generate_series(1,$2::integer) g WHERE q>=0) AS embedding
       FROM generate_series(1,$1::integer) q`,
      [settings.queries, PORTAL_EMBEDDING_DIMENSIONS]
    );
    const embeddings = vectorText(queries.rows.map((row) => row.embedding));
    await setReader(client);
    const allowed = await client.query<{ versionId: string }>(
      'SELECT "currentVersionId" AS "versionId" FROM portal.search_allowed_documents($1,ARRAY[$2]::text[])',
      [companyId, sourceId]
    );
    const allowedVersions = allowed.rows.map((row) => row.versionId);
    const authorizedDocuments = allowedVersions.length;
    if (authorizedDocuments !== Math.ceil(settings.documents / every))
      throw new Error("Calibration ACL did not select the expected documents");

    let annHits = 0;
    let postFilteredHits = 0;
    let annPath: RetrievalPath | null = null;
    let annUsesIndex = true;
    let postFilteredUsesIndex = true;
    for (const embedding of embeddings) {
      await client.query("SAVEPOINT calibration_query");
      try {
        await client.query("SET LOCAL ROLE portal_read");
        await setReader(client);
        const exact = await client.query<{ id: string }>(
          "SELECT id FROM portal.search_vector_exact($1,ARRAY[$2]::text[],$3,$4,$5)",
          [companyId, sourceId, profile, embedding, settings.k]
        );
        const ann = await client.query<{
          id: string;
          retrievalPath: RetrievalPath;
        }>(
          'SELECT id,"retrievalPath" FROM portal.search_vector_ann($1,ARRAY[$2]::text[],$3,$4,$5)',
          [companyId, sourceId, profile, embedding, settings.k]
        );
        for (const row of ann.rows) {
          if (annPath && annPath !== row.retrievalPath)
            throw new Error("Vector search mixed retrieval paths");
          annPath = row.retrievalPath;
        }
        annHits += recallAtK(
          exact.rows.map((row) => row.id),
          ann.rows.map((row) => row.id),
          settings.k
        );
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT calibration_query");
      }
      // Negative control and plan check run as the administrator: the ACL is
      // the explicit filter, exactly as inside the function, never row policy.
      await client.query("SAVEPOINT calibration_plan");
      try {
        const exact = await client.query<{ id: string }>(
          `SELECT c.id FROM portal.chunk c
           WHERE c."companyId"=$1 AND c."embeddingProfile"=$2 AND c.embedding IS NOT NULL AND c."documentVersionId"=ANY($3::text[])
           ORDER BY c.embedding OPERATOR(extensions.<=>) $4::extensions.vector(768),c.id LIMIT $5`,
          [companyId, profile, allowedVersions, embedding, settings.k]
        );
        await client.query("SET LOCAL hnsw.iterative_scan=relaxed_order");
        const annPlan = await client.query(
          `EXPLAIN (FORMAT JSON) ${annStatement}`,
          [companyId, profile, allowedVersions, embedding, settings.k]
        );
        annUsesIndex &&= planUsesIndex(
          annPlan.rows[0]?.["QUERY PLAN"]?.[0]?.Plan
        );
        await client.query(
          `SET LOCAL hnsw.iterative_scan=off; SET LOCAL hnsw.ef_search=${PGVECTOR_DEFAULT_EF_SEARCH}`
        );
        const postPlan = await client.query(
          `EXPLAIN (FORMAT JSON) ${annStatement}`,
          [companyId, profile, allowedVersions, embedding, settings.k]
        );
        postFilteredUsesIndex &&= planUsesIndex(
          postPlan.rows[0]?.["QUERY PLAN"]?.[0]?.Plan
        );
        const postFiltered = await client.query<{ id: string }>(annStatement, [
          companyId,
          profile,
          allowedVersions,
          embedding,
          settings.k
        ]);
        postFilteredHits += recallAtK(
          exact.rows.map((row) => row.id),
          postFiltered.rows.map((row) => row.id),
          settings.k
        );
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT calibration_plan");
      }
    }
    return {
      k: settings.k,
      queries: settings.queries,
      documents: settings.documents,
      authorizedDocuments,
      selectivity: authorizedDocuments / settings.documents,
      vectorVersion,
      iterativeScan: supportsIterativeScan(vectorVersion),
      ann: {
        recallAtK: annHits / settings.queries,
        path: annPath,
        usesIndex: annUsesIndex
      },
      postFiltered: {
        recallAtK: postFilteredHits / settings.queries,
        usesIndex: postFilteredUsesIndex
      }
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

/** Transaction-local identity of the calibration reader (mirrors withPortalTransaction). */
async function setReader(client: PoolClient) {
  await client.query(
    "SELECT set_config('portal.company_id',$1,true),set_config('portal.actor_id',$2,true),set_config('portal.caller_id','recall-calibration',true)",
    [companyId, readerId]
  );
}

/** Synthetic calibration corpus; the caller owns the transaction and rolls it back. */
export async function installRecallFixture(
  client: PoolClient,
  documents: number,
  every: number
) {
  await client.query(
    "INSERT INTO public.company(id) VALUES ($1) ON CONFLICT DO NOTHING",
    [companyId]
  );
  await client.query(
    'INSERT INTO public."user"(id) VALUES ($1) ON CONFLICT DO NOTHING',
    [readerId]
  );
  await client.query(
    'INSERT INTO public."userToCompany"("userId","companyId") VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [readerId, companyId]
  );
  await client.query(
    `INSERT INTO portal."identityBinding"(id,"companyId","createdBy",issuer,subject,"canonicalUserId",active,capabilities)
     VALUES ('recall_binding',$1,$2,'https://identity.example.com','recall-subject',$2,true,ARRAY['portal.read']) ON CONFLICT DO NOTHING`,
    [companyId, readerId]
  );
  await client.query(
    `INSERT INTO portal.source(id,"companyId","createdBy",kind,"externalId","displayName","ownerId",classification,"providerPolicy")
     VALUES ($3,$1,$2,'upload','recall-calibration','Recall calibration fixture',$2,'internal','{}') ON CONFLICT DO NOTHING`,
    [companyId, readerId, sourceId]
  );
  await client.query(
    `INSERT INTO portal.document(id,"companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification)
     SELECT 'recall_doc_'||to_char(value,'FM00000'),$1,$2,$3,'recall_item_'||value,'Recall document '||value,$2,'manual','draft','internal'
     FROM generate_series(0,$4::integer-1) value`,
    [companyId, readerId, sourceId, documents]
  );
  await client.query(
    `INSERT INTO portal."documentVersion"(id,"companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus")
     SELECT 'recall_version_'||to_char(value,'FM00000'),$1,$2,'recall_doc_'||to_char(value,'FM00000'),'1','recall-'||value,'synthetic/recall/'||value||'.pdf','1','application/pdf',100,now(),'synthetic-recall-v1','ready'
     FROM generate_series(0,$3::integer-1) value`,
    [companyId, readerId, documents]
  );
  await client.query(
    `UPDATE portal.document SET "currentVersionId"='recall_version_'||right(id,5),status='published',version=version+1
     WHERE "companyId"=$1 AND "sourceId"=$2 AND "currentVersionId" IS NULL`,
    [companyId, sourceId]
  );
  await client.query(
    `INSERT INTO portal."grant"(id,"companyId","createdBy","sourceId","documentId","subjectKind","subjectId",capability,origin,"policyVersion")
     SELECT 'recall_grant_'||to_char(value,'FM00000'),$1,$2,$3,'recall_doc_'||to_char(value,'FM00000'),'user',$2,'read','local',1
     FROM generate_series(0,$4::integer-1) value WHERE value % $5::integer = 0`,
    [companyId, readerId, sourceId, documents, every]
  );
  await client.query(
    `INSERT INTO portal.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,"tokenCount",embedding,"embeddingProfile","indexGeneration")
     SELECT 'recall_chunk_'||to_char(value,'FM00000'),$1,$2,'recall_doc_'||to_char(value,'FM00000'),'recall_version_'||to_char(value,'FM00000'),0,
       'Recall calibration chunk '||value,4,
       ('['||(SELECT string_agg((random()-0.5)::text,',') FROM generate_series(1,$5::integer) g WHERE value>=0)||']')::extensions.vector(768),
       $3,1
     FROM generate_series(0,$4::integer-1) value`,
    [companyId, readerId, profile, documents, PORTAL_EMBEDDING_DIMENSIONS]
  );
  await client.query(
    'ANALYZE portal.chunk; ANALYZE portal.document; ANALYZE portal."documentVersion"; ANALYZE portal."grant"'
  );
}
