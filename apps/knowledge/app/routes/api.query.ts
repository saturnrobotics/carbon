import { forwardKnowledgeQuery } from "../services/query-gateway.server";

export function action({ request }: { request: Request }) {
  const queryUrl = process.env.KNOWLEDGE_QUERY_URL;
  const queryAudience = process.env.KNOWLEDGE_QUERY_AUDIENCE;
  const companyId = process.env.KNOWLEDGE_COMPANY_ID;
  if (!queryUrl || !queryAudience || !companyId) {
    return Response.json({ error: "query_not_configured" }, { status: 503 });
  }
  return forwardKnowledgeQuery(request, { queryUrl, queryAudience, companyId });
}
