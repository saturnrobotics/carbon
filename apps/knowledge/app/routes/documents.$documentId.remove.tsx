import { readManualSourceConfiguration } from "@carbon/knowledge/release-profile";
import { Form, redirect, useLoaderData } from "react-router";
import { forwardIntakeRequest } from "../modules/intake/intake.service";

export function loader() {
  const source = readManualSourceConfiguration(process.env);
  return { sourceDisplayName: source.displayName };
}

export async function action({
  request,
  params
}: {
  request: Request;
  params: { documentId?: string };
}) {
  readManualSourceConfiguration(process.env);
  const documentId = params.documentId?.trim();
  const companyId = process.env.KNOWLEDGE_COMPANY_ID?.trim() ?? "";
  if (!documentId || !companyId)
    throw new Response("Manual removal is not configured", { status: 503 });
  const response = await forwardIntakeRequest({
    request,
    companyId,
    workerPath: `/v1/documents/${encodeURIComponent(documentId)}`,
    method: "DELETE",
    body: JSON.stringify({ requestId: crypto.randomUUID() }),
    contentType: "application/json"
  });
  if (!response.ok) throw response;
  return redirect("/");
}

export default function RemoveManualRoute() {
  const { sourceDisplayName } = useLoaderData<typeof loader>();
  return (
    <main className="page-shell">
      <a className="back-link" href="/">
        Back to manual search
      </a>
      <h1>Remove this manual?</h1>
      <p>
        This removes the manual from {sourceDisplayName} search and blocks its
        original version from download.
      </p>
      <Form method="post">
        <button type="submit">Confirm removal</button>
      </Form>
    </main>
  );
}
