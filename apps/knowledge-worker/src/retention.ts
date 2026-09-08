import type {
  RetentionRecord,
  RetentionStats
} from "@carbon/knowledge/retention.server";
import type { Storage } from "@google-cloud/storage";

export type RetentionBatchDependencies = {
  candidates: () => Promise<RetentionRecord[]>;
  deleteObject: (objectKey: string, generation: string) => Promise<void>;
  finalize: (records: readonly RetentionRecord[]) => Promise<RetentionStats>;
};

export type RetentionBatchResult = RetentionStats & { deletedObjects: number };

export function createImmutableObjectDeleter(
  storage: Pick<Storage, "bucket">,
  bucketName: string
): RetentionBatchDependencies["deleteObject"] {
  return async (objectKey, generation) => {
    await storage
      .bucket(bucketName)
      .file(objectKey, { generation })
      .delete({ ignoreNotFound: true });
  };
}

export async function runRetentionBatch(
  dependencies: RetentionBatchDependencies
): Promise<RetentionBatchResult> {
  const records = await dependencies.candidates();
  let deletedObjects = 0;
  for (const record of records) {
    for (const object of record.objects) {
      await dependencies.deleteObject(object.objectKey, object.generation);
      deletedObjects += 1;
    }
  }
  const stats = await dependencies.finalize(records);
  return { ...stats, deletedObjects };
}
