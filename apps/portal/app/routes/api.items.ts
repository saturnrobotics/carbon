import { forwardItemSearch } from "../services/item-gateway.server";

export function action({ request }: { request: Request }) {
  const queryUrl = process.env.PORTAL_QUERY_URL;
  const queryAudience = process.env.PORTAL_QUERY_AUDIENCE;
  const companyId = process.env.PORTAL_COMPANY_ID;
  if (!queryUrl || !queryAudience || !companyId) {
    return Response.json({ error: "items_not_configured" }, { status: 503 });
  }
  return forwardItemSearch(request, { queryUrl, queryAudience, companyId });
}
