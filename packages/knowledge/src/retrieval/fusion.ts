export function reciprocalRankFusion<T extends { id: string }>(
  rankings: readonly (readonly T[])[],
  limit = 8
): Array<T & { score: number }> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 8 ||
    rankings.length > 4
  ) {
    throw new Error("Retrieval budget exceeded");
  }
  const combined = new Map<string, T & { score: number }>();
  for (const ranking of rankings) {
    if (ranking.length > 40) throw new Error("Candidate budget exceeded");
    const seen = new Set<string>();
    for (const [rank, candidate] of ranking.entries()) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const previous = combined.get(candidate.id);
      combined.set(candidate.id, {
        ...candidate,
        score: (previous?.score ?? 0) + 1 / (60 + rank + 1)
      });
    }
  }
  return [...combined.values()]
    .sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id, "en")
    )
    .slice(0, limit);
}
