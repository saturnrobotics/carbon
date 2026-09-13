import {
  type DriveSource,
  describeProviderEligibility
} from "../sources.models";

function scopeLabel(source: DriveSource): string {
  const drive =
    source.corpora === "drive"
      ? `Shared Drive ${source.driveId ?? ""}`.trim()
      : "My Drive folders";
  return source.rootFolderIds.length
    ? `${drive}: ${source.rootFolderIds.length} enrolled folder${source.rootFolderIds.length === 1 ? "" : "s"}`
    : `${drive}: entire drive`;
}

function syncLabel(source: DriveSource): string {
  if (!source.lastSyncAt) return "Never synchronized";
  return `${source.lastSyncStatus === "failed" ? "Last sync failed" : "Last sync succeeded"} at ${source.lastSyncAt}`;
}

export function DriveSourceList({
  sources,
  requested
}: {
  sources: DriveSource[];
  requested?: string | null;
}) {
  if (!sources.length)
    return (
      <p data-testid="drive-sources-empty">
        No Google Drive sources are enrolled for this company.
      </p>
    );
  return (
    <ul className="source-list" aria-label="Enrolled Drive sources">
      {sources.map((source) => (
        <li key={source.sourceId} data-testid="drive-source">
          <h2>{source.displayName}</h2>
          <dl>
            <dt>Connector scope</dt>
            <dd>{scopeLabel(source)}</dd>
            <dt>Connector access</dt>
            <dd>
              {source.oauthScope.endsWith("drive.readonly")
                ? "Read-only"
                : source.oauthScope}
              {source.domainWideDelegation
                ? " (domain-wide delegation)"
                : " (no domain-wide delegation)"}
            </dd>
            <dt>Reader live check scope</dt>
            <dd>{source.userAccessScope}</dd>
            <dt>Source owner</dt>
            <dd>{source.ownerId}</dd>
            <dt>Classification</dt>
            <dd>{source.classification}</dd>
            <dt>Provider eligibility</dt>
            <dd>{describeProviderEligibility(source.providerPolicy)}</dd>
            <dt>Published documents</dt>
            <dd>{source.documentCount}</dd>
            <dt>Synchronization</dt>
            <dd>
              {syncLabel(source)}; full reconciliation every{" "}
              {source.reconcileAfterHours} h
              {source.reconciledAt ? `, last at ${source.reconciledAt}` : ""}
            </dd>
          </dl>
          <form method="post">
            <input type="hidden" name="sourceId" value={source.sourceId} />
            <button type="submit" name="intent" value="sync">
              Reconcile now
            </button>
            {requested === source.sourceId ? (
              <span role="status"> Reconciliation requested.</span>
            ) : null}
          </form>
        </li>
      ))}
    </ul>
  );
}
