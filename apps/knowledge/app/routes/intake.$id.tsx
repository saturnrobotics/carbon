import { redirect, useLoaderData } from "react-router";
import { manualMetadataSchema } from "../modules/intake/intake.models";
import { forwardIntakeRequest } from "../modules/intake/intake.service";
import { IntakeReview } from "../modules/intake/ui/IntakeReview";

export async function loader({
  request,
  params
}: {
  request: Request;
  params: { id?: string };
}) {
  const companyId = process.env.KNOWLEDGE_COMPANY_ID?.trim() ?? "";
  const response = await forwardIntakeRequest({
    request,
    companyId,
    workerPath: `/v1/intake/${encodeURIComponent(params.id ?? "")}`
  });
  if (!response.ok) throw response;
  return response.json();
}

export async function action({
  request,
  params
}: {
  request: Request;
  params: { id?: string };
}) {
  const form = await request.formData();
  const companyId = process.env.KNOWLEDGE_COMPANY_ID?.trim() ?? "";
  const intent = String(form.get("intent") ?? "review");
  const expectedGeneration = String(form.get("expectedGeneration") ?? "");
  const expectedVersion = String(form.get("expectedVersion") ?? "");
  let body: string;
  if (intent === "publish") {
    body = JSON.stringify({
      expectedGeneration,
      expectedVersion,
      requestId: String(form.get("requestId") ?? "")
    });
  } else {
    try {
      body = JSON.stringify({
        expectedGeneration,
        expectedVersion,
        metadata: manualMetadataSchema.parse(
          JSON.parse(String(form.get("metadata") ?? "{}"))
        )
      });
    } catch {
      throw new Response("Valid manual metadata is required", { status: 422 });
    }
  }
  const response = await forwardIntakeRequest({
    request,
    companyId,
    workerPath: `/v1/intake/${encodeURIComponent(params.id ?? "")}/${intent === "publish" ? "publish" : "review"}`,
    body,
    contentType: "application/json"
  });
  if (!response.ok) throw response;
  if (intent === "publish")
    return redirect(`/intake/${encodeURIComponent(params.id ?? "")}`);
  return response;
}

export default function IntakeReviewRoute() {
  const data = useLoaderData() as {
    intake: {
      id: string;
      version?: string;
      generation?: string;
      state: "captured" | "extracting" | "needs-review" | "ready" | "failed";
      extraction?: Record<string, string>;
      extractionOutput?: {
        evidence?: Record<string, Array<{ page: number; text: string }>>;
      };
      reviewDecisions?: Record<string, { value?: string }>;
      reviewedMetadata?: Record<string, string>;
      unresolved?: string[];
    };
  };
  const intake = data.intake;
  const corrected =
    intake.reviewedMetadata ??
    Object.fromEntries(
      Object.entries(intake.reviewDecisions ?? {}).flatMap(
        ([field, decision]) =>
          typeof decision.value === "string" ? [[field, decision.value]] : []
      )
    );
  const sourcePages = Object.values(intake.extractionOutput?.evidence ?? {})
    .flat()
    .slice(0, 100);
  return (
    <main className="page-shell">
      <a className="back-link" href="/">
        Back to manual search
      </a>
      <h1>Review document</h1>
      <IntakeReview
        model={{
          id: intake.id,
          version: intake.version,
          generation: intake.generation,
          state: intake.state,
          title: intake.extraction?.title ?? "Captured document",
          proposed: intake.extraction ?? {},
          corrected,
          unresolved: intake.unresolved ?? [],
          sourcePages
        }}
      />
    </main>
  );
}
