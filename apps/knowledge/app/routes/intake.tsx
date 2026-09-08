import { readManualSourceConfiguration } from "@carbon/knowledge/release-profile";
import { redirect, useLoaderData } from "react-router";
import { forwardIntakeRequest } from "../modules/intake/intake.service";
import { IntakeUpload } from "../modules/intake/ui/IntakeUpload";

export function loader() {
  const source = readManualSourceConfiguration(process.env);
  return { sourceDisplayName: source.displayName };
}

export async function action({ request }: { request: Request }) {
  readManualSourceConfiguration(process.env);
  const form = await request.formData();
  const companyId = process.env.KNOWLEDGE_COMPANY_ID?.trim() ?? "";
  if (!companyId) throw new Response("Company is required", { status: 422 });
  const response = await forwardIntakeRequest({
    request,
    companyId,
    workerPath: "/v1/intake",
    body: form
  });
  if (!response.ok) throw response;
  const captured = (await response.json()) as { id?: string };
  if (!captured.id) throw new Response("Capture failed", { status: 503 });
  return redirect(`/intake/${encodeURIComponent(captured.id)}`);
}
export default function IntakeRoute() {
  const { sourceDisplayName } = useLoaderData<typeof loader>();
  return (
    <main className="page-shell">
      <a className="back-link" href="/">
        Back to manual search
      </a>
      <h1>Upload a manual</h1>
      <p>Access follows this library&apos;s permissions.</p>
      <IntakeUpload sourceDisplayName={sourceDisplayName} />
    </main>
  );
}
