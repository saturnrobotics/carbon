import { pathToFileURL } from "node:url";
import {
  finalizeRetention,
  retentionCandidates
} from "@carbon/knowledge/retention.server";
import { createTelemetry } from "@carbon/knowledge/telemetry";
import { Storage } from "@google-cloud/storage";
import { Pool } from "pg";
import { createImmutableObjectDeleter, runRetentionBatch } from "./retention";

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function runRetentionJob(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const databaseUrl = required(
    environment,
    "KNOWLEDGE_MAINTENANCE_DATABASE_URL"
  );
  const bucketName = required(environment, "KNOWLEDGE_OBJECT_BUCKET");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const storage = new Storage();
  const telemetry = createTelemetry("worker");
  const started = performance.now();
  try {
    const result = await runRetentionBatch({
      candidates: () => retentionCandidates(pool),
      deleteObject: createImmutableObjectDeleter(storage, bucketName),
      finalize: (records) => finalizeRetention(pool, records)
    });
    telemetry.record("retention", "success", {
      durationMs: performance.now() - started,
      count: result.deletedObjects
    });
  } catch (error) {
    telemetry.record("retention", "error", {
      durationMs: performance.now() - started
    });
    throw error;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runRetentionJob().catch(() => {
    process.exitCode = 1;
  });
