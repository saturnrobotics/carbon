import { forwardPortalQuery } from "../services/query-gateway.server";

export function action({ request }: { request: Request }) {
  const queryUrl = process.env.PORTAL_QUERY_URL;
  const queryAudience = process.env.PORTAL_QUERY_AUDIENCE;
  const companyId = process.env.PORTAL_COMPANY_ID;
  if (!queryUrl || !queryAudience || !companyId) {
    return Response.json({ error: "query_not_configured" }, { status: 503 });
  }
  return forwardPortalQuery(request, { queryUrl, queryAudience, companyId });
}
