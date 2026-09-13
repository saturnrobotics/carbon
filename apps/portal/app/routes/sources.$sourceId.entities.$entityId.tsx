import type { SourceEntity, SourceEntityRequest } from "@carbon/portal";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useLoaderData } from "react-router";
import { forwardPortalEntity } from "../services/entity-gateway.server";

export async function loader({
  request,
  params
}: {
  request: Request;
  params: { sourceId?: string; entityId?: string };
}) {
  const queryUrl = process.env.PORTAL_QUERY_URL;
  const queryAudience = process.env.PORTAL_QUERY_AUDIENCE;
  const companyId = process.env.PORTAL_COMPANY_ID;
  if (!queryUrl || !queryAudience || !companyId) {
    throw Response.json({ error: "not_configured" }, { status: 503 });
  }
  const kind = new URL(request.url).searchParams.get("kind") ?? undefined;
  const input: SourceEntityRequest = {
    sourceId: params.sourceId ?? "",
    entityId: params.entityId ?? "",
    ...(kind ? { kind: kind as SourceEntityRequest["kind"] } : {})
  };
  const response = await forwardPortalEntity(request, input, {
    queryUrl,
    queryAudience,
    companyId
  });
  if (!response.ok) throw response;
  return response;
}

export default function SourceEntityRoute() {
  const { t } = useLingui();
  const entity = useLoaderData<typeof loader>() as SourceEntity;
  return (
    <main className="page-shell entity-page">
      <Link className="back-link" to="/">
        <Trans>Back to Portal</Trans>
      </Link>
      <header>
        <p className="eyebrow">{entity.kind}</p>
        <h1>{entity.title}</h1>
        {entity.description ? <p>{entity.description}</p> : null}
      </header>
      <section aria-label={t`Source details`} className="entity-card">
        <dl>
          {Object.entries(entity.fields).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value === null ? t`Not set` : String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <footer className="entity-provenance">
        <span>
          <Trans>Source revision: {entity.sourceRevision}</Trans>
        </span>
        <time dateTime={entity.observedAt}>
          <Trans>Observed {entity.observedAt}</Trans>
        </time>
      </footer>
    </main>
  );
}
