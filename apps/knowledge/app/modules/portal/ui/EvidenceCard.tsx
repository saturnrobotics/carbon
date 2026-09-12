import type { Evidence } from "@carbon/knowledge";
import { Trans, useLingui } from "@lingui/react/macro";

/** The DOM id a citation link points at. */
export function evidenceAnchor(evidence: Pick<Evidence, "id">): string {
  return `evidence-${encodeURIComponent(evidence.id)}`;
}

/**
 * One result card. A document card opens the exact immutable version (and
 * page) the excerpt came from; a live-source record card opens the record in
 * the application that owns it, which re-authorizes on open.
 */
export function EvidenceCard({
  evidence,
  index,
  sourceDisplayName
}: {
  evidence: Evidence;
  /** The citation number shown on the card and used by answer claims. */
  index?: number;
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
  const isRecord = Boolean(evidence.entityId) && !evidence.documentVersionId;
  const page = evidence.page;
  const freshness =
    evidence.freshness === "current"
      ? t`Current version`
      : evidence.freshness === "partial"
        ? t`Partial source answer`
        : evidence.freshness === "unavailable"
          ? t`Source unavailable`
          : t`Check freshness`;
  return (
    <article className="evidence-card" id={evidenceAnchor(evidence)}>
      <div className="evidence-meta">
        <span>
          {index ? <span className="evidence-index">[{index}]</span> : null}
          {freshness}
        </span>
        <span>{isRecord ? t`Live record` : sourceDisplayName}</span>
      </div>
      <h3>{evidence.title}</h3>
      {evidence.section ? (
        <p className="evidence-section">{evidence.section}</p>
      ) : null}
      {evidence.excerpt ? <p>{evidence.excerpt}</p> : null}
      {isRecord ? (
        <a href={evidence.sourceUri} rel="noreferrer">
          <Trans>Open record</Trans>
        </a>
      ) : (
        <a href={evidence.sourceUri} rel="noreferrer">
          {page ? t`Download original · page ${page}` : t`Download original`}
        </a>
      )}
      {removalPath ? (
        <a href={removalPath}>
          <Trans>Remove manual</Trans>
        </a>
      ) : null}
    </article>
  );
}
