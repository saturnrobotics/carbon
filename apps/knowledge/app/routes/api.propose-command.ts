import { forwardCommandProposal } from "../services/command-proposal-gateway.server";

export function action({ request }: { request: Request }) {
  const queryUrl = process.env.KNOWLEDGE_QUERY_URL;
  const queryAudience = process.env.KNOWLEDGE_QUERY_AUDIENCE;
  const companyId = process.env.KNOWLEDGE_COMPANY_ID;
  if (!queryUrl || !queryAudience || !companyId)
    return Response.json(
      { error: "command_proposal_not_configured" },
      { status: 503 }
    );
  return forwardCommandProposal(request, {
    queryUrl,
    queryAudience,
    companyId
  });
}
