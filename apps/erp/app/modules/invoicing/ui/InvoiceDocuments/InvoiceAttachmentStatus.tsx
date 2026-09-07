import { Trans } from "@lingui/react/macro";

export function InvoiceAttachmentStatus({ status }: { status: string }) {
  if (status !== "Pending" && status !== "Failed") return null;
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {status === "Failed" ? (
        <Trans>
          Invoice attachment copy needs retrying. The original document remains
          available in its review; automatic retry is scheduled.
        </Trans>
      ) : (
        <Trans>
          Copying the attachment to the invoice. The original document remains
          available in its review.
        </Trans>
      )}
    </p>
  );
}
