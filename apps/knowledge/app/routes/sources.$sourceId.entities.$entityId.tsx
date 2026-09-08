import type { SourceEntity, SourceEntityRequest } from "@carbon/knowledge";
import { Link, useLoaderData } from "react-router";
import { forwardKnowledgeEntity } from "../services/entity-gateway.server";

export async function loader({
  request,
  params
}: {
  request: Request;
  params: { sourceId?: string; entityId?: string };
}) {
  const queryUrl = process.env.KNOWLEDGE_QUERY_URL;
  const queryAudience = process.env.KNOWLEDGE_QUERY_AUDIENCE;
  const companyId = process.env.KNOWLEDGE_COMPANY_ID;
  if (!queryUrl || !queryAudience || !companyId) {
    throw Response.json({ error: "entity_not_configured" }, { status: 503 });
  }
  const kind = new URL(request.url).searchParams.get("kind") ?? undefined;
  const input: SourceEntityRequest = {
    sourceId: params.sourceId ?? "",
    entityId: params.entityId ?? "",
    ...(kind ? { kind: kind as SourceEntityRequest["kind"] } : {})
  };
  const response = await forwardKnowledgeEntity(request, input, {
    queryUrl,
    queryAudience,
    companyId
  });
  if (!response.ok) throw response;
  return response;
}

export default function SourceEntityRoute() {
  const entity = useLoaderData<typeof loader>() as SourceEntity;
  return (
    <main className="page-shell entity-page">
      <Link className="back-link" to="/">
        Back to company knowledge
      </Link>
      <header>
        <p className="eyebrow">{entity.kind}</p>
        <h1>{entity.title}</h1>
        {entity.description ? <p>{entity.description}</p> : null}
      </header>
      <section aria-label="Source details" className="entity-card">
        <dl>
          {Object.entries(entity.fields).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value === null ? "Not set" : String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <footer className="entity-provenance">
        <span>Source revision: {entity.sourceRevision}</span>
        <time dateTime={entity.observedAt}>Observed {entity.observedAt}</time>
      </footer>
    </main>
  );
}
