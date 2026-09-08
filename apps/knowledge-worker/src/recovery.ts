import type { RecoveryIndexInput } from "@carbon/knowledge/retention.server";

export type RecoveryIndexDependencies = {
  candidates: () => Promise<RecoveryIndexInput[]>;
  rebuild: (input: RecoveryIndexInput) => Promise<void>;
};

export async function runRecoveryIndexBatch(
  dependencies: RecoveryIndexDependencies
): Promise<{ rebuilt: number }> {
  const candidates = await dependencies.candidates();
  let rebuilt = 0;
  for (const candidate of candidates) {
    await dependencies.rebuild(candidate);
    rebuilt += 1;
  }
  return { rebuilt };
}
