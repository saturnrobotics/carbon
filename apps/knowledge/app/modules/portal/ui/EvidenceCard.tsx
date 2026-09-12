import type { Evidence } from "@carbon/knowledge";
import { Trans, useLingui } from "@lingui/react/macro";

export function EvidenceCard({
  evidence,
  sourceDisplayName
}: {
  evidence: Evidence;
  sourceDisplayName: string;
}) {
  const { t } = useLingui();
  let removalPath: string | undefined;
  try {
    const path = new URL(evidence.sourceUri).pathname;
    const match = path.match(/^\/documents\/([^/]+)\/versions\/[^/]+$/);
    if (match?.[1]) removalPath = `/documents/${match[1]}/remove`;
  } catch {
    removalPath = undefined;
  }
  const page = evidence.page;
  return (
    <article className="evidence-card">
      <div className="evidence-meta">
        <span>
          {evidence.freshness === "current"
            ? t`Current version`
            : t`Check freshness`}
        </span>
        <span>{sourceDisplayName}</span>
      </div>
      <h3>{evidence.title}</h3>
      {evidence.excerpt ? <p>{evidence.excerpt}</p> : null}
      <a href={evidence.sourceUri} rel="noreferrer">
        {page ? t`Download original · page ${page}` : t`Download original`}
      </a>
      {removalPath ? (
        <a href={removalPath}>
          <Trans>Remove manual</Trans>
        </a>
      ) : null}
    </article>
  );
}
