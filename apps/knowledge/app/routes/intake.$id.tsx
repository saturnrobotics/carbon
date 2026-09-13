import { Trans } from "@lingui/react/macro";
import { data, redirect, useActionData, useLoaderData } from "react-router";
import {
  intakeReviewModel,
  reviewSubmissionSchema
} from "../modules/intake/intake.models";
import {
  forwardIntakeRequest,
  workerErrorCode
} from "../modules/intake/intake.service";
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
  return intakeReviewModel(await response.json());
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
    // Publishing is its own intent: the worker re-checks the publish
    // capability, the library grant, and unresolved evidence itself.
    body = JSON.stringify({
      expectedGeneration,
      expectedVersion,
      requestId: String(form.get("requestId") ?? "")
    });
  } else {
    try {
      const submission = reviewSubmissionSchema.parse({
        metadata: JSON.parse(String(form.get("metadata") ?? "{}")),
        item: JSON.parse(String(form.get("item") ?? "null"))
      });
      body = JSON.stringify({
        expectedGeneration,
        expectedVersion,
        metadata: submission.metadata,
        item: submission.item
      });
    } catch {
      throw new Response("review_invalid", { status: 422 });
    }
  }
  const response = await forwardIntakeRequest({
    request,
    companyId,
    workerPath: `/v1/intake/${encodeURIComponent(params.id ?? "")}/${intent === "publish" ? "publish" : "review"}`,
    body,
    contentType: "application/json"
  });
  if (!response.ok)
    return data(
      { error: await workerErrorCode(response) },
      { status: response.status }
    );
  if (intent === "publish")
    return redirect(`/intake/${encodeURIComponent(params.id ?? "")}`);
  return response;
}

export default function IntakeReviewRoute() {
  const model = useLoaderData<typeof loader>();
  const attempt = useActionData<typeof action>();
  const error =
    attempt && typeof attempt === "object" && "error" in attempt
      ? (attempt as { error?: string }).error
      : undefined;
  return (
    <main className="page-shell page-shell-wide">
      <a className="back-link" href="/">
        <Trans>Back to manual search</Trans>
      </a>
      <h1>
        <Trans>Review document</Trans>
      </h1>
      <IntakeReview error={error} model={model} />
    </main>
  );
}
