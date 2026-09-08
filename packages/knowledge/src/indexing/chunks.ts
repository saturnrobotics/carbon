export type SourceBlock = {
  kind: "heading" | "paragraph" | "table" | "footnote";
  text: string;
  page: number;
  bounds?: unknown;
  sourceOffset?: number;
  units?: string[];
  caption?: string;
};
export type KnowledgeChunk = {
  ordinal: number;
  page: number;
  text: string;
  parentHeading?: string;
  bounds?: unknown;
  parentOrdinal?: number;
  sourceOffset?: number;
  units?: string[];
  caption?: string;
};

/** Provider inputs are byte-bounded; code-point iteration never leaves a split surrogate. */
export function splitForEmbedding(
  text: string,
  maximumBytes = 8_000
): string[] {
  if (
    !Number.isInteger(maximumBytes) ||
    maximumBytes < 4 ||
    maximumBytes > 8_192
  )
    throw new Error("Invalid embedding chunk byte limit");
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const point of text) {
    const pointBytes = encoder.encode(point).length;
    if (bytes + pointBytes > maximumBytes && current) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += point;
    bytes += pointBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Tables remain with adjacent heading/footnote context, so critical values retain meaning. */
export function chunkBlocks(
  blocks: readonly SourceBlock[],
  maximum = 4_000
): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let heading: string | undefined;
  let pending = "";
  let page = 1;
  let metadata: Omit<
    KnowledgeChunk,
    "ordinal" | "page" | "text" | "parentHeading"
  > = {};
  const flush = () => {
    if (pending)
      chunks.push({
        ordinal: chunks.length,
        page,
        text: pending,
        parentHeading: heading,
        ...metadata
      });
    pending = "";
    metadata = {};
  };
  for (const block of blocks) {
    if (block.kind === "heading") {
      flush();
      heading = block.text;
      page = block.page;
      continue;
    }
    const atomic = block.kind === "table" || block.kind === "footnote";
    if (pending && pending.length + block.text.length + 1 > maximum && !atomic)
      flush();
    if (!pending) page = block.page;
    if (!pending)
      metadata = {
        bounds: block.bounds,
        sourceOffset: block.sourceOffset,
        units: block.units,
        caption: block.caption
      };
    pending = pending ? `${pending}\n${block.text}` : block.text;
  }
  flush();
  return chunks;
}
