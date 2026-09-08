import { forwardIntakeRequest } from "../modules/intake/intake.service";

export async function loader({
  request,
  params
}: {
  request: Request;
  params: { documentId?: string; versionId?: string };
}) {
  const companyId = process.env.KNOWLEDGE_COMPANY_ID?.trim() ?? "";
  return forwardIntakeRequest({
    request,
    companyId,
    workerPath: `/v1/documents/${encodeURIComponent(params.documentId ?? "")}/versions/${encodeURIComponent(params.versionId ?? "")}`
  });
}
