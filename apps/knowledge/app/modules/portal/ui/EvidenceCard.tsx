import type { Evidence } from "@carbon/knowledge";

export function EvidenceCard({
  evidence,
  sourceDisplayName
}: {
  evidence: Evidence;
  sourceDisplayName: string;
}) {
  let removalPath: string | undefined;
  try {
    const path = new URL(evidence.sourceUri).pathname;
    const match = path.match(/^\/documents\/([^/]+)\/versions\/[^/]+$/);
    if (match?.[1]) removalPath = `/documents/${match[1]}/remove`;
  } catch {
    removalPath = undefined;
  }
  return (
    <article className="evidence-card">
      <div className="evidence-meta">
        <span>
          {evidence.freshness === "current"
            ? "Current version"
            : "Check freshness"}
        </span>
        <span>{sourceDisplayName}</span>
      </div>
      <h3>{evidence.title}</h3>
      {evidence.excerpt ? <p>{evidence.excerpt}</p> : null}
      <a href={evidence.sourceUri} rel="noreferrer">
        Download original{evidence.page ? ` · page ${evidence.page}` : ""}
      </a>
      {removalPath ? <a href={removalPath}>Remove manual</a> : null}
    </article>
  );
}
