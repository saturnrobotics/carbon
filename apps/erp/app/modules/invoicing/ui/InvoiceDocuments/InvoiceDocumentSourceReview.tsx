import { Card, CardContent, CardHeader, CardTitle } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { InvoiceIntakeReview } from "../../invoicing.models";
import { InvoiceChoiceField, InvoiceTextField } from "./InvoiceDocumentLines";

export type InvoiceReviewSource = {
  id: string;
  sha256: string;
  fileName: string | null;
};

export function InvoiceDocumentSourceReview({
  sources,
  primarySha256,
  extractionSha256,
  header,
  disabled,
  onPrimaryChange,
  onAcknowledgementsChange
}: {
  sources: InvoiceReviewSource[];
  primarySha256: string | null;
  extractionSha256: string | null;
  header: InvoiceIntakeReview["header"];
  disabled: boolean;
  onPrimaryChange: (sha256: string | null) => void;
  onAcknowledgementsChange: (
    acknowledgements: InvoiceIntakeReview["header"]["sourceAcknowledgements"]
  ) => void;
}) {
  const { t } = useLingui();
  if (!sources.length) return null;
  const acknowledgements = header.sourceAcknowledgements;
  const reasonFor = (sha256: string) =>
    acknowledgements.find((entry) => entry.sha256 === sha256)?.reason ?? null;
  const changeReason = (sha256: string, reason: string | null) => {
    onAcknowledgementsChange([
      ...acknowledgements.filter((entry) => entry.sha256 !== sha256),
      ...(reason ? [{ sha256, reason }] : [])
    ]);
  };
  const options = sources.map((source, index) => ({
    value: source.sha256,
    label: `${index + 1}. ${source.fileName ?? t`Receipt or invoice`}`
  }));
  const extractionDiffers =
    extractionSha256 && primarySha256 && extractionSha256 !== primarySha256;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Trans>Invoice source</Trans>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          <Trans>
            Choose the invoice or receipt that defines this purchase. Review
            every other attachment and explain why it adds no separate invoice
            lines. Documents for another purchase need a separate review.
          </Trans>
        </p>
        <InvoiceChoiceField
          label={t`Invoice document to parse`}
          value={primarySha256}
          options={options}
          onChange={onPrimaryChange}
          disabled={
            disabled ||
            (sources.length === 1 && sources[0].sha256 === primarySha256)
          }
        />
        {!disabled &&
          (sources.length > 1 ||
            !sources.some((source) => source.sha256 === primarySha256)) && (
            <p className="text-sm text-muted-foreground">
              <Trans>
                Changing this selection keeps your current review fields. Save
                the review, then use Parse again to read the selected document.
              </Trans>
            </p>
          )}
        {primarySha256 && (
          <div className="space-y-2">
            {extractionDiffers && (
              <p role="status" className="text-sm">
                <Trans>
                  The extracted facts came from another document. Parse the
                  selected invoice, or check every line and total manually and
                  describe your review below.
                </Trans>
              </p>
            )}
            <InvoiceTextField
              label={t`Manual review of selected invoice`}
              value={reasonFor(primarySha256)}
              onChange={(reason) => changeReason(primarySha256, reason)}
              disabled={disabled}
            />
            <p className="text-sm text-muted-foreground">
              <Trans>
                Optional unless the extracted facts came from another file.
                Confirm that you manually entered or reviewed these invoice
                facts against the selected document.
              </Trans>
            </p>
          </div>
        )}
        {sources
          .filter((source) => source.sha256 !== primarySha256)
          .map((source) => {
            const name = options.find(
              (option) => option.value === source.sha256
            )!.label;
            return (
              <InvoiceTextField
                key={source.sha256}
                label={t`Review reason for ${name}`}
                value={reasonFor(source.sha256)}
                onChange={(reason) => changeReason(source.sha256, reason)}
                disabled={disabled}
              />
            );
          })}
        {sources.length > 1 && (
          <p className="text-sm text-muted-foreground">
            <Trans>
              For each other file, explain whether it is a duplicate, payment
              confirmation, supporting evidence, or unrelated to this invoice.
              Review decisions apply once per distinct file, even when the same
              file arrived from several sources.
            </Trans>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
