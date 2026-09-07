import { requirePermissions } from "@carbon/auth/auth.server";
import { isMercuryAttachmentPath } from "@carbon/database/mercury";
import { getInvoiceApprovedSourceHashes } from "@carbon/jobs";
import { isInvoiceSourcePath } from "@carbon/jobs/invoice-intake";
import { msg } from "@lingui/core/macro";
import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { getInvoiceIntakeReview } from "~/modules/invoicing/invoicing.server";
import { InvoiceDocumentReview } from "~/modules/invoicing/ui/InvoiceDocuments/InvoiceDocumentReview";
import { getDatabaseClient } from "~/services/database.server";
import type { Handle } from "~/utils/handle";

export const handle: Handle = {
  breadcrumb: msg`Review document`,
  module: "invoicing"
};
export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requirePermissions(request, { view: "invoicing" });
  if (!params.intakeId)
    throw new Response("Document not found", { status: 404 });
  const result = await getInvoiceIntakeReview(
    getDatabaseClient(),
    actor,
    params.intakeId
  );
  const approvedHashes = ["Approved", "Linked"].includes(result.intake.status)
    ? getInvoiceApprovedSourceHashes(result.intake.approvalSnapshot)
    : null;
  const signedSources = await Promise.all(
    result.sources
      .filter(
        (source) =>
          (approvedHashes === null
            ? result.eligibleSourceIds.includes(source.id)
            : ["mercury", "upload"].includes(source.kind) &&
              source.sha256 &&
              approvedHashes.includes(source.sha256)) &&
          source.storagePath &&
          source.sha256
      )
      .map(async (source) => {
        const url =
          source.storageBucket === "private" &&
          source.storagePath &&
          (isInvoiceSourcePath(actor.companyId, source.storagePath) ||
            isMercuryAttachmentPath(actor.companyId, source.storagePath))
            ? ((
                await actor.client.storage
                  .from("private")
                  .createSignedUrl(source.storagePath, 600)
              ).data?.signedUrl ?? null)
            : null;
        return {
          id: source.id,
          sha256: source.sha256,
          storagePath: source.storagePath,
          fileName: source.fileName,
          mediaType: source.mediaType,
          archived: !result.eligibleSourceIds.includes(source.id),
          url
        };
      })
  );
  return { ...result, signedSources };
}
export default function InvoiceDocumentRoute() {
  const result = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  useEffect(() => {
    if (
      !["Queued", "Processing"].includes(result.intake.status) &&
      !result.readinessPending
    )
      return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [result.intake.status, result.readinessPending, revalidator]);
  return <InvoiceDocumentReview key={result.intake.id} data={result} />;
}
