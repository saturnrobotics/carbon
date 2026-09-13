import { writableIntakeSourcesSchema } from "@carbon/knowledge";
import { readManualSourceConfiguration } from "@carbon/knowledge/release-profile";
import { Trans } from "@lingui/react/macro";
import { data, redirect, useActionData, useLoaderData } from "react-router";
import {
  forwardIntakeRequest,
  workerErrorCode
} from "../modules/intake/intake.service";
import { IntakeUpload } from "../modules/intake/ui/IntakeUpload";

export async function loader({ request }: { request: Request }) {
  readManualSourceConfiguration(process.env);
  const companyId = process.env.KNOWLEDGE_COMPANY_ID?.trim() ?? "";
  if (!companyId) throw new Response("company_required", { status: 422 });
  // A caller who cannot list any library still sees the form: the worker is
  // the gate, and its refusal is reported on the attempt rather than by
  // hiding the page.
  try {
    const response = await forwardIntakeRequest({
      request,
      companyId,
      workerPath: "/v1/sources/writable"
    });
    if (!response.ok) return { actorId: "", sources: [] };
    const writable = writableIntakeSourcesSchema.parse(await response.json());
    return { actorId: writable.actorId, sources: writable.sources };
  } catch {
    return { actorId: "", sources: [] };
  }
}

export async function action({ request }: { request: Request }) {
  readManualSourceConfiguration(process.env);
  const form = await request.formData();
  const companyId = process.env.KNOWLEDGE_COMPANY_ID?.trim() ?? "";
  if (!companyId) throw new Response("company_required", { status: 422 });
  const response = await forwardIntakeRequest({
    request,
    companyId,
    workerPath: "/v1/intake",
    body: form
  });
  if (!response.ok)
    return data(
      { error: await workerErrorCode(response) },
      { status: response.status }
    );
  const captured = (await response.json()) as { id?: string };
  if (!captured.id) throw new Response("capture_failed", { status: 503 });
  return redirect(`/intake/${encodeURIComponent(captured.id)}`);
}

export default function IntakeRoute() {
  const { actorId, sources } = useLoaderData<typeof loader>();
  const attempt = useActionData<typeof action>();
  return (
    <main className="page-shell">
      <a className="back-link" href="/">
        <Trans>Back to manual search</Trans>
      </a>
      <h1>
        <Trans>Add a document</Trans>
      </h1>
      <p>
        <Trans>
          Upload a manual, photograph a nameplate, or point at a public address.
          Access follows the library you choose.
        </Trans>
      </p>
      <IntakeUpload
        actorId={actorId}
        error={attempt?.error}
        sources={sources}
      />
    </main>
  );
}
