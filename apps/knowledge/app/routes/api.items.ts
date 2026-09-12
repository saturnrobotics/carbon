import { forwardItemSearch } from "../services/item-gateway.server";

export function action({ request }: { request: Request }) {
  const queryUrl = process.env.KNOWLEDGE_QUERY_URL;
  const queryAudience = process.env.KNOWLEDGE_QUERY_AUDIENCE;
  const companyId = process.env.KNOWLEDGE_COMPANY_ID;
  if (!queryUrl || !queryAudience || !companyId) {
    return Response.json({ error: "items_not_configured" }, { status: 503 });
  }
  return forwardItemSearch(request, { queryUrl, queryAudience, companyId });
}
