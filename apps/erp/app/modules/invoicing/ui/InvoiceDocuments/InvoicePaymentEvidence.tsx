import { Card, CardContent, CardHeader, CardTitle } from "@carbon/react";
import { formatDate } from "@carbon/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { InvoiceTextField } from "./InvoiceDocumentLines";

export function InvoicePaymentEvidence({
  payments,
  reconciliation,
  requireExplanation,
  reason,
  onReasonChange,
  disabled
}: {
  payments: {
    id: string;
    mercuryTransactionId: string;
    payee: string | null;
    amount: string;
    currencyCode: string;
    transactionDate: string;
    reference: string | null;
    memo: string | null;
    lastErrorCode: string | null;
    remoteStatus: string;
    receiptAcquisition: {
      attachmentCount: number;
      hasGeneratedReceipt: boolean | null;
      checkedAt: string;
      attachments: {
        id: string;
        fileName: string;
        status: "saved" | "unsupported" | "unavailable" | "limit";
      }[];
    } | null;
  }[];
  reconciliation: {
    status:
      | "unavailable"
      | "matched"
      | "difference"
      | "currencyMismatch"
      | "unsettled";
    paymentTotal: string | null;
    difference: string | null;
    currencyCode: string | null;
  };
  requireExplanation: boolean;
  reason: string | null;
  onReasonChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const { t } = useLingui();
  if (!payments.length) return null;
  const needsExplanation =
    reconciliation.status === "difference" ||
    reconciliation.status === "unsettled";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Trans>Mercury payment evidence</Trans>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          <Trans>
            These are bank payment details. Invoice totals and the supplier are
            reviewed separately from the receipt.
          </Trans>
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {payments.map((payment) => (
            <div key={payment.id} className="rounded border p-3 space-y-1">
              <p>
                <strong>{payment.payee ?? t`Payee unavailable`}</strong>
              </p>
              <p className="tabular-nums">
                {payment.currencyCode} {payment.amount} ·{" "}
                {formatDate(payment.transactionDate)}
              </p>
              <p>
                <Trans>Payment status</Trans>: {payment.remoteStatus}
              </p>
              <p className="break-all text-sm text-muted-foreground">
                <Trans>ID</Trans>: {payment.mercuryTransactionId}
              </p>
              {payment.reference && (
                <p>
                  <Trans>Reference</Trans>: {payment.reference}
                </p>
              )}
              {payment.memo && (
                <p>
                  <Trans>Memo</Trans>: {payment.memo}
                </p>
              )}
              {payment.receiptAcquisition ? (
                <div className="text-sm space-y-1">
                  <p>
                    <Trans>Receipts last checked</Trans>:{" "}
                    {formatDate(
                      payment.receiptAcquisition.checkedAt.slice(0, 10)
                    )}
                  </p>
                  {payment.receiptAcquisition.attachmentCount === 0 && (
                    <p>
                      <Trans>
                        Mercury has no uploaded receipt or invoice for this
                        payment.
                      </Trans>
                    </p>
                  )}
                  {payment.receiptAcquisition.attachments.map((attachment) => (
                    <div key={attachment.id} className="space-y-1">
                      <p className="font-medium">{attachment.fileName}</p>
                      {attachment.status === "saved" && (
                        <p>
                          <Trans>Attachment saved.</Trans>
                        </p>
                      )}
                      {attachment.status === "unsupported" && (
                        <p>
                          <Trans>
                            This file type cannot be parsed. Upload a PDF, PNG,
                            or JPEG version.
                          </Trans>
                        </p>
                      )}
                      {attachment.status === "unavailable" && (
                        <p>
                          <Trans>
                            This attachment could not be downloaded from
                            Mercury. Find the document again or upload the
                            original file.
                          </Trans>
                        </p>
                      )}
                      {attachment.status === "limit" && (
                        <p>
                          <Trans>
                            The attachment limit was reached. Review the saved
                            files and upload the receipt needed for this
                            purchase.
                          </Trans>
                        </p>
                      )}
                    </div>
                  ))}
                  {payment.receiptAcquisition.hasGeneratedReceipt && (
                    <p className="text-muted-foreground">
                      <Trans>
                        Mercury also offers a generated payment receipt. Payment
                        confirmation alone does not identify the purchased line
                        items.
                      </Trans>
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>Receipt collection status is not available yet.</Trans>
                </p>
              )}
              {payment.lastErrorCode && !payment.receiptAcquisition && (
                <p className="text-sm text-muted-foreground">
                  <Trans>Receipt collection needs attention.</Trans>
                </p>
              )}
            </div>
          ))}
        </div>
        {reconciliation.paymentTotal !== null && (
          <p className="tabular-nums">
            <Trans>Payment total</Trans>: {reconciliation.currencyCode}{" "}
            {reconciliation.paymentTotal}
          </p>
        )}
        {reconciliation.status === "matched" && (
          <p>
            <Trans>The payment total matches the reviewed invoice total.</Trans>
          </p>
        )}
        {reconciliation.status === "difference" && (
          <p role="status">
            <Trans>
              The payment total differs from the reviewed invoice total.
            </Trans>{" "}
            <Trans>Difference</Trans>: {reconciliation.currencyCode}{" "}
            {reconciliation.difference}
          </p>
        )}
        {reconciliation.status === "currencyMismatch" && (
          <p role="status">
            <Trans>
              Payment and invoice currencies differ. Payments cannot be linked
              to an invoice in a different currency.
            </Trans>
          </p>
        )}
        {reconciliation.status === "unsettled" && (
          <p role="status">
            <Trans>
              At least one payment is not confirmed as sent. Explain its status
              before creating a draft. Approval does not mark it as paid.
            </Trans>
          </p>
        )}
        {(needsExplanation || reason) && (
          <InvoiceTextField
            label={t`Explain the payment difference, status, or allocation`}
            value={reason}
            onChange={onReasonChange}
            disabled={disabled}
          />
        )}
        {needsExplanation && requireExplanation && (
          <p className="text-sm text-muted-foreground">
            <Trans>
              Explain any partial payment, grouped payments, fees, or currency
              conversion before approval. This explanation does not change the
              invoice amounts or reconcile the bank payment.
            </Trans>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
