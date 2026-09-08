import type { Pool } from "pg";
import { z } from "zod";

const objectReferenceSchema = z
  .object({
    objectKey: z.string().min(1).max(2_048),
    generation: z.string().regex(/^\d+$/)
  })
  .strict();

const retentionRecordSchema = z
  .object({
    recordKind: z.enum(["intake", "document-version"]),
    recordId: z.string().min(1).max(256),
    companyId: z.string().min(1).max(256),
    objects: z.array(objectReferenceSchema).max(100)
  })
  .strict();

const retentionStatsSchema = z
  .object({
    intakes: z.number().int().nonnegative(),
    documentVersions: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    chunks: z.number().int().nonnegative(),
    audits: z.number().int().nonnegative(),
    outbox: z.number().int().nonnegative(),
    requestWindows: z.number().int().nonnegative()
  })
  .strict();

const recoveryIndexInputSchema = z
  .object({
    companyId: z.string().min(1).max(256),
    sourceId: z.string().min(1).max(256),
    documentId: z.string().min(1).max(256),
    versionId: z.string().min(1).max(256),
    objectKey: z.string().min(1).max(2_048),
    generation: z.string().regex(/^\d+$/),
    contentHash: z.string().min(1).max(256),
    mimeType: z.string().min(1).max(256),
    parserVersion: z.string().min(1).max(256)
  })
  .strict();

export type RetentionRecord = z.infer<typeof retentionRecordSchema>;
export type RetentionStats = z.infer<typeof retentionStatsSchema>;
export type RecoveryIndexInput = z.infer<typeof recoveryIndexInputSchema>;

export async function retentionCandidates(
  pool: Pick<Pool, "query">,
  limit = 100
): Promise<RetentionRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Retention batch size must be between 1 and 500");
  const result = await pool.query(
    `SELECT "recordKind","recordId","companyId",objects
     FROM knowledge.retention_candidates($1)`,
    [limit]
  );
  return z.array(retentionRecordSchema).max(500).parse(result.rows);
}

export async function finalizeRetention(
  pool: Pick<Pool, "query">,
  records: readonly RetentionRecord[]
): Promise<RetentionStats> {
  const receipt = z.array(retentionRecordSchema).max(500).parse(records);
  const result = await pool.query<{
    result: unknown;
    requestWindows: unknown;
  }>(
    `SELECT knowledge.finalize_retention($1::jsonb) AS result,
      knowledge.cleanup_operational_retention() AS "requestWindows"`,
    [JSON.stringify(receipt)]
  );
  const row = result.rows[0];
  return retentionStatsSchema.parse({
    ...(typeof row?.result === "object" && row.result ? row.result : {}),
    requestWindows: row?.requestWindows
  });
}

export async function recoveryIndexCandidates(
  pool: Pick<Pool, "query">,
  limit = 100
): Promise<RecoveryIndexInput[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Recovery batch size must be between 1 and 500");
  const result = await pool.query(
    `SELECT "companyId","sourceId","documentId","versionId","objectKey",
      generation,"contentHash","mimeType","parserVersion"
     FROM knowledge.recovery_index_candidates($1)`,
    [limit]
  );
  return z.array(recoveryIndexInputSchema).max(500).parse(result.rows);
}
