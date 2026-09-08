import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { summarizeMeasurements, type PerformanceMeasurement } from "../src/evaluation/performance";
import { withKnowledgeTransaction } from "../src/database.server";
import { lexicalSearch } from "../src/retrieval/lexical.server";
import { vectorSearch } from "../src/retrieval/vector.server";
import { getDisposableLocalDatabaseUrl } from "../src/test/database";

type Question = { id: string; userId: string; term: string; expectedDocumentId: string };
type Mode = "exact-acl" | "lexical" | "vector";

const companyId = "company-a";
const sourceId = "perf_source_100k";
const vectorProfile = "perf-vector-768-v1";
const logicalChunksPerDocument = 200;
const expectedQuestionCount = 500;
const expectedUserCount = 10;

function vectorFor(documentIndex: number): number[] {
  return Array.from({ length: 768 }, (_, dimension) => Number(dimension === documentIndex));
}

function parseQuestions(text: string): Question[] {
  const rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Question);
  if (rows.length !== expectedQuestionCount || new Set(rows.map((row) => row.userId)).size !== expectedUserCount)
    throw new Error("performance fixture requires exactly 500 questions across 10 users");
  for (const row of rows) {
    if (!/^perf-q-\d{3}$/.test(row.id) || !/^perf_user_\d$/.test(row.userId) || !/^perfword\d{3}$/.test(row.term) || !/^perf_doc_\d{3}$/.test(row.expectedDocumentId))
      throw new Error("performance questions must use the labelled synthetic fixture");
  }
  return rows;
}

async function installFixture(pool: pg.Pool, questions: readonly Question[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public."user"(id)
       SELECT 'perf_user_'||value FROM generate_series(0,9) value ON CONFLICT DO NOTHING`
    );
    await client.query(
      `INSERT INTO public."userToCompany"("userId","companyId")
       SELECT 'perf_user_'||value,$1 FROM generate_series(0,9) value ON CONFLICT DO NOTHING`,
      [companyId]
    );
    await client.query(
      `INSERT INTO knowledge."identityBinding"(id,"companyId","createdBy",issuer,subject,"canonicalUserId",active,capabilities)
       SELECT 'perf_binding_'||value,$1,'automation','https://identity.example.com','perf-subject-'||value,'perf_user_'||value,true,ARRAY['knowledge.read']
       FROM generate_series(0,9) value ON CONFLICT DO NOTHING`,
      [companyId]
    );
    await client.query(
      `INSERT INTO knowledge.source(id,"companyId","createdBy",kind,"externalId","displayName","ownerId",classification,"providerPolicy")
       VALUES ($1,$2,'automation','drive','perf-drive-100k','Synthetic 100k retrieval fixture','automation','internal','{}') ON CONFLICT DO NOTHING`,
      [sourceId, companyId]
    );
    await client.query(
      `INSERT INTO knowledge.document(id,"companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification)
       SELECT 'perf_doc_'||to_char(value,'FM000'),$1,'automation',$2,'perf_item_'||to_char(value,'FM000'),
        'Synthetic manual '||to_char(value,'FM000'),'perf_user_'||(value%10),'manual','draft','internal'
       FROM generate_series(0,499) value ON CONFLICT DO NOTHING`,
      [companyId, sourceId]
    );
    await client.query(
      `INSERT INTO knowledge."sourceUserBinding"(id,"companyId","createdBy","sourceId","canonicalUserId","sourceUserId",active)
       SELECT 'perf_source_binding_'||value,$1,'automation',$2,'perf_user_'||value,'perf-drive-user-'||value,true
       FROM generate_series(0,9) value ON CONFLICT DO NOTHING`,
      [companyId, sourceId]
    );
    await client.query(
      `INSERT INTO knowledge."documentVersion"(id,"companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus")
       SELECT 'perf_version_'||to_char(value,'FM000'),$1,'automation','perf_doc_'||to_char(value,'FM000'),'perf_revision_1',repeat(to_char(value,'FM000'),21)||'0',
        'synthetic/performance/'||to_char(value,'FM000')||'.pdf','1','application/pdf',100,now(),'synthetic-performance-v1','ready'
       FROM generate_series(0,499) value ON CONFLICT DO NOTHING`,
      [companyId]
    );
    await client.query(
      `UPDATE knowledge.document SET "currentVersionId"='perf_version_'||right(id,3),status='published',"updatedBy"='automation',"updatedAt"=now(),version=version+1
       WHERE "companyId"=$1 AND "sourceId"=$2 AND id LIKE 'perf_doc_%' AND "currentVersionId" IS NULL`,
      [companyId, sourceId]
    );
    await client.query(
      `INSERT INTO knowledge."grant"(id,"companyId","createdBy","sourceId","documentId","subjectKind","subjectId",capability,origin,"policyVersion")
       SELECT 'perf_grant_local_'||to_char(value,'FM000'),$1,'automation',$2,'perf_doc_'||to_char(value,'FM000'),'user','perf_user_'||(value%10),'read','local',1
       FROM generate_series(0,499) value ON CONFLICT DO NOTHING`,
      [companyId, sourceId]
    );
    await client.query(
      `INSERT INTO knowledge."grant"(id,"companyId","createdBy","sourceId","documentId","subjectKind","subjectId",capability,origin,"policyVersion")
       SELECT 'perf_grant_source_'||to_char(value,'FM000'),$1,'automation',$2,'perf_doc_'||to_char(value,'FM000'),'user','perf_user_'||(value%10),'read','source',1
       FROM generate_series(0,499) value ON CONFLICT DO NOTHING`,
      [companyId, sourceId]
    );
    await client.query(
      `INSERT INTO knowledge.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,"tokenCount","embeddingProfile","indexGeneration")
       SELECT 'perf_chunk_l_'||to_char(document_index,'FM000')||'_'||to_char(ordinal,'FM000'),$1,'automation',
        'perf_doc_'||to_char(document_index,'FM000'),'perf_version_'||to_char(document_index,'FM000'),ordinal,
        'perfword'||to_char(document_index,'FM000')||' synthetic motor manual section '||ordinal,8,'lexical-v1',1
       FROM generate_series(0,499) document_index CROSS JOIN generate_series(0,$2::integer-1) ordinal ON CONFLICT DO NOTHING`,
      [companyId, logicalChunksPerDocument]
    );
    const vectors = questions.map((question, index) => ({ documentId: question.expectedDocumentId, embedding: `[${vectorFor(index).join(",")}]` }));
    await client.query(
      `INSERT INTO knowledge.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,"tokenCount",embedding,"embeddingProfile","indexGeneration")
       SELECT 'perf_chunk_v_'||right(lexical."documentId",3)||'_'||to_char(lexical.ordinal,'FM000'),lexical."companyId",'automation',lexical."documentId",lexical."documentVersionId",lexical.ordinal,
        lexical.text,lexical."tokenCount",vectors.embedding::extensions.vector,$2,lexical."indexGeneration"
       FROM knowledge.chunk lexical
       JOIN jsonb_to_recordset($3::jsonb) AS vectors("documentId" text,embedding text) ON vectors."documentId"=lexical."documentId"
       WHERE lexical."companyId"=$1 AND lexical."embeddingProfile"='lexical-v1' AND lexical."documentId" LIKE 'perf_doc_%'
       ON CONFLICT DO NOTHING`,
      [companyId, vectorProfile, JSON.stringify(vectors)]
    );
    await client.query("ANALYZE knowledge.document; ANALYZE knowledge.\"documentVersion\"; ANALYZE knowledge.\"grant\"; ANALYZE knowledge.chunk");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function prepareReadPool(databaseUrl: string): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: expectedUserCount, connectionTimeoutMillis: 5_000 });
  const clients = await Promise.all(Array.from({ length: expectedUserCount }, () => pool.connect()));
  try {
    await Promise.all(clients.map((client) => client.query("SET ROLE knowledge_read")));
  } finally {
    for (const client of clients) client.release();
  }
  return pool;
}

async function queryOne(pool: pg.Pool, question: Question, mode: Mode): Promise<PerformanceMeasurement> {
  const start = performance.now();
  try {
    const principal = { companyId, actorId: question.userId, callerId: "performance-evaluation" };
    const rows = mode === "lexical"
      ? await withKnowledgeTransaction(pool, principal, "read", (client) => lexicalSearch(client, companyId, [sourceId], question.term, 10))
      : mode === "vector"
        ? await withKnowledgeTransaction(pool, principal, "read", (client) => vectorSearch(client, companyId, [sourceId], vectorFor(Number(question.id.slice(-3))), vectorProfile, 10))
        : await withKnowledgeTransaction(pool, principal, "read", async (client) => (await client.query<{ documentId: string }>(
          `SELECT id AS "documentId" FROM knowledge.document WHERE "companyId"=$1 AND id=$2 AND "sourceId"=$3 AND status='published' AND "deletedAt" IS NULL`,
          [companyId, question.expectedDocumentId, sourceId]
        )).rows);
    return { durationMs: performance.now() - start, ok: true, recalled: rows.some((row) => row.documentId === question.expectedDocumentId) };
  } catch {
    return { durationMs: performance.now() - start, ok: false, recalled: false };
  }
}

async function runPhase(pool: pg.Pool, questions: readonly Question[], mode: Mode): Promise<PerformanceMeasurement[]> {
  const workers = Array.from({ length: expectedUserCount }, (_, worker) => questions.filter((_, index) => index % expectedUserCount === worker));
  return (await Promise.all(workers.map(async (assigned) => {
    const measurements: PerformanceMeasurement[] = [];
    for (const question of assigned) measurements.push(await queryOne(pool, question, mode));
    return measurements;
  }))).flat();
}

async function explainBaseline(pool: pg.Pool, question: Question) {
  const principal = { companyId, actorId: question.userId, callerId: "performance-evaluation" };
  const plans: Record<string, unknown> = {};
  const statements: Record<Mode, { sql: string; values: unknown[] }> = {
    "exact-acl": { sql: `SELECT id FROM knowledge.document WHERE "companyId"=$1 AND id=$2 AND "sourceId"=$3`, values: [companyId, question.expectedDocumentId, sourceId] },
    lexical: { sql: `SELECT * FROM knowledge.search_lexical($1,$2::text[],$3,$4)`, values: [companyId, [sourceId], question.term, 10] },
    vector: { sql: `SELECT * FROM knowledge.search_vector_exact($1,$2::text[],$3,$4,$5)`, values: [companyId, [sourceId], vectorProfile, `[${vectorFor(0).join(",")}]`, 10] }
  };
  for (const mode of ["exact-acl", "lexical", "vector"] as const) {
    try {
      plans[mode] = await withKnowledgeTransaction(pool, principal, "read", async (client) => {
        const result = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statements[mode].sql}`, statements[mode].values);
        const plan = result.rows[0]?.["QUERY PLAN"]?.[0];
        return plan ? { planningTimeMs: plan["Planning Time"], executionTimeMs: plan["Execution Time"], plan: plan.Plan } : null;
      });
    } catch (error) {
      plans[mode] = { error: error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : "explain failed" };
    }
  }
  return plans;
}

async function main() {
  const databaseUrl = getDisposableLocalDatabaseUrl();
  const questionsPath = resolve(import.meta.dirname, "../evaluations/questions.jsonl");
  const questions = parseQuestions(await readFile(questionsPath, "utf8"));
  const adminUrl = new URL(databaseUrl);
  adminUrl.username = "supabase_admin";
  adminUrl.password = "synthetic-test-only";
  const adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1, connectionTimeoutMillis: 5_000 });
  try {
    await installFixture(adminPool, questions);
  } finally {
    await adminPool.end();
  }
  const pool = await prepareReadPool(databaseUrl);
  try {
    const plans = await explainBaseline(pool, questions[0]!);
    const phases: Record<string, ReturnType<typeof summarizeMeasurements>> = {};
    for (const temperature of ["cold", "warm"] as const) {
      for (const mode of ["exact-acl", "lexical", "vector"] as const) {
        phases[`${temperature}:${mode}`] = summarizeMeasurements(await runPhase(pool, questions, mode));
      }
    }
    const report = {
      schemaVersion: 1,
      scope: "local disposable PostgreSQL retrieval and RLS only; excludes IAP, HTTP, model synthesis, and true OS cache eviction",
      fixture: { questions: questions.length, concurrentUsers: expectedUserCount, documents: questions.length, logicalChunks: questions.length * logicalChunksPerDocument, chunkRowsIncludingLexicalAndVectorProfiles: questions.length * logicalChunksPerDocument * 2, aclSelectivityPerUser: 0.1 },
      coldDefinition: "first measured pass in a new evaluator process after fixture verification and ANALYZE; operating-system page cache is not evicted",
      warmDefinition: "second measured pass in the same process and database",
      plans,
      phases
    };
    const outputArgument = process.argv.find((value) => value.startsWith("--output="));
    if (outputArgument) await writeFile(resolve(process.cwd(), outputArgument.slice("--output=".length)), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "performance evaluation failed");
  process.exitCode = 1;
});
