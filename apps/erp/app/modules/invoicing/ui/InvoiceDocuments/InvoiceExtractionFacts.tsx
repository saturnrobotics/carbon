import type { InvoiceExtractionEnvelope } from "@carbon/jobs";
import { Button, HStack } from "@carbon/react";
import { INPUT_FORMAT } from "@carbon/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import type { InvoiceIntakeReview } from "../../invoicing.models";
import { InvoiceTextField } from "./InvoiceDocumentLines";

export function InvoiceExtractionFacts({
  extraction,
  review,
  pendingReview,
  disabled,
  onAdd,
  onExclude
}: {
  extraction: InvoiceExtractionEnvelope;
  review: InvoiceIntakeReview;
  pendingReview: boolean;
  disabled: boolean;
  onAdd: (lineKey: string) => void;
  onExclude: (lineKey: string, reason: string) => void;
}) {
  const { t } = useLingui();
  const [reasons, setReasons] = useState<Record<string, string | null>>({});
  const labels: Record<string, string> = {
    invoiceNumber: t`Invoice number`,
    issueDate: t`Invoice date`,
    dueDate: t`Due date`,
    currencyCode: t`Currency`,
    subtotal: t`Subtotal`,
    discount: t`Discount`,
    shipping: t`Shipping`,
    tax: t`Tax`,
    total: t`Total`,
    quantity: t`Quantity`,
    unitPrice: t`Unit price`,
    purchaseUnit: t`Purchase unit`,
    lineTotal: t`Line total`,
    supplierSku: t`Supplier SKU`,
    manufacturerPartNumber: t`Manufacturer part number`,
    taxPercent: t`Tax percent`
  };
  const fact = (
    key: string,
    field: {
      value: string | null;
      confidence: number | null;
      page: number | null;
    }
  ) => (
    <p key={key}>
      <strong>{labels[key] ?? key}</strong>: {field.value ?? t`Missing`} ·{" "}
      {field.confidence === null
        ? t`Confidence unavailable`
        : new Intl.NumberFormat(undefined, INPUT_FORMAT.percent).format(
            field.confidence
          )}{" "}
      {field.page && `· ${t`Page`} ${field.page}`}
    </p>
  );
  return (
    <details className="rounded border p-3" open={pendingReview || undefined}>
      <summary>
        <Trans>Extracted facts and confidence</Trans>
      </summary>
      <div className="space-y-3 pt-3 text-sm">
        <p>
          <strong>
            <Trans>Vendor on document</Trans>
          </strong>
          : {extraction.supplier.name.value ?? t`Missing`}
        </p>
        <div>
          {Object.entries(extraction.header).map(([key, field]) =>
            fact(key, field)
          )}
        </div>
        <p className="text-muted-foreground">
          <Trans>
            These are the latest parsed facts. Your review fields remain
            unchanged until you edit them or add a source line.
          </Trans>
        </p>
        {extraction.lines.map((line) => {
          const inReview = review.lines.some(
            (current) => current.lineKey === line.lineKey
          );
          const excluded = review.header.excludedLines.find(
            (current) => current.lineKey === line.lineKey
          );
          return (
            <div key={line.lineKey} className="rounded border p-3 space-y-2">
              <p className="font-medium">
                {line.description.value ?? t`Missing`}
              </p>
              <p className="text-muted-foreground">
                <Trans>Source line</Trans>: {line.lineKey}
              </p>
              <div className="grid gap-x-3 sm:grid-cols-2">
                {Object.entries(line)
                  .filter(([key]) => Object.hasOwn(labels, key))
                  .map(([key, field]) =>
                    fact(
                      key,
                      field as InvoiceExtractionEnvelope["lines"][number]["quantity"]
                    )
                  )}
              </div>
              {inReview ? (
                <p>
                  <Trans>Included in review</Trans>
                </p>
              ) : excluded ? (
                <p>
                  <Trans>Excluded source lines</Trans>: {excluded.reason}
                </p>
              ) : (
                <p>
                  <Trans>This source line is not in your saved review.</Trans>
                </p>
              )}
              {!inReview && !disabled && (
                <>
                  {!excluded && (
                    <InvoiceTextField
                      label={t`Exclusion reason`}
                      value={reasons[line.lineKey] ?? null}
                      onChange={(reason) =>
                        setReasons((current) => ({
                          ...current,
                          [line.lineKey]: reason
                        }))
                      }
                    />
                  )}
                  <HStack className="flex-wrap">
                    <Button
                      variant="secondary"
                      onClick={() => onAdd(line.lineKey)}
                    >
                      <Trans>Add extracted line</Trans>
                    </Button>
                    {!excluded && (
                      <Button
                        variant="secondary"
                        isDisabled={!reasons[line.lineKey]?.trim()}
                        onClick={() =>
                          onExclude(line.lineKey, reasons[line.lineKey]!.trim())
                        }
                      >
                        <Trans>Exclude source line</Trans>
                      </Button>
                    )}
                  </HStack>
                </>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
