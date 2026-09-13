import { UnauthorizedRequestError } from "@carbon/portal/identity.server";
import { forwardIntakeRequest } from "../modules/intake/intake.service";

const denialHeaders = { "cache-control": "no-store" };

export async function loader({
  request,
  params
}: {
  request: Request;
  params: { documentId?: string; versionId?: string };
}) {
  const companyId = process.env.PORTAL_COMPANY_ID?.trim() ?? "";
  try {
    return await forwardIntakeRequest({
      request,
      companyId,
      workerPath: `/v1/documents/${encodeURIComponent(params.documentId ?? "")}/versions/${encodeURIComponent(params.versionId ?? "")}`
    });
  } catch (error) {
    // A resource route renders no ErrorBoundary, so a throw here reached React
    // Router's last resort: a 500 whose text/plain body was the Error itself.
    // An unauthenticated download is an authentication failure and says so with
    // a status; the short code is the whole body, and names the class only.
    if (error instanceof UnauthorizedRequestError)
      return Response.json(
        { error: "unauthorized" },
        { status: 401, headers: denialHeaders }
      );
    return Response.json(
      { error: "service_unavailable" },
      { status: 503, headers: denialHeaders }
    );
  }
}
