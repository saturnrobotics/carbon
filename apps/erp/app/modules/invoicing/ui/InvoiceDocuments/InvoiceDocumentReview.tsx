import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Heading,
  HStack
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import { useCountries } from "~/components/Form/Country";
import { DeferredMasterCreation } from "~/components/Form/DeferredMasterCreation";
import {
  consumableValidator,
  materialValidator,
  partValidator,
  serviceValidator,
  toolValidator
} from "~/modules/items/items.models";
import { supplierValidator } from "~/modules/purchasing/purchasing.models";
import SupplierForm from "~/modules/purchasing/ui/Supplier/SupplierForm";
import { useItems, useSuppliers } from "~/stores";
import { setCustomFields } from "~/utils/form";
import { path } from "~/utils/path";
import {
  extractionToInvoiceReview,
  getInvoicePaymentReconciliation,
  getInvoiceReviewReadiness
} from "../../invoice-intake.utils";
import type { InvoiceIntakeReview } from "../../invoicing.models";
import type { getInvoiceIntakeReview } from "../../invoicing.server";
import { InvoiceAttachmentStatus } from "./InvoiceAttachmentStatus";
import {
  InvoiceChoiceField,
  InvoiceDecimalField,
  InvoiceDocumentLines,
  InvoiceTextField,
  InvoiceToggle
} from "./InvoiceDocumentLines";
import {
  InvoiceDocumentSourceReview,
  type InvoiceReviewSource
} from "./InvoiceDocumentSourceReview";
import { InvoiceExtractionFacts } from "./InvoiceExtractionFacts";
import { InvoicePaymentEvidence } from "./InvoicePaymentEvidence";
import {
  InvoiceRecognitionRules,
  invoiceRuleLabel
} from "./InvoiceRecognitionRules";
import {
  type InvoicePreviewSource,
  invoiceCountryCode,
  invoiceReceiptReason,
  invoiceSupplierProposalDefaults,
  selectInvoicePreviewSource
} from "./invoice-document.utils";
import { useInvoiceDocumentLabels } from "./useInvoiceDocumentLabels";

type ReviewData = Awaited<ReturnType<typeof getInvoiceIntakeReview>> & {
  signedSources: InvoicePreviewSource[];
};
const nativeItemValidators = {
  Part: partValidator,
  Material: materialValidator,
  Consumable: consumableValidator,
  Tool: toolValidator,
  Service: serviceValidator
};

export function InvoiceDocumentReview({ data }: { data: ReviewData }) {
  const { t } = useLingui();
  const statusLabel = useInvoiceDocumentLabels();
  const addressLabels = {
    addressLine2: t`Address line 2`,
    city: t`City`,
    stateProvince: t`State or province`,
    postalCode: t`Postal code`
  };
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const revalidator = useRevalidator();
  const refreshPreview = useRef(false);
  const [review, setReview] = useState(data.review);
  const [baseRevision, setBaseRevision] = useState(data.intake.revision);
  const [dirty, setDirty] = useState(false);
  const [supplierProposalOpen, setSupplierProposalOpen] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [storedSuppliers] = useSuppliers();
  const countries = useCountries();
  const suppliers = useMemo(
    () => [
      ...new Map(
        [...storedSuppliers, ...data.selectedSuppliers].map((supplier) => [
          supplier.id,
          supplier
        ])
      ).values()
    ],
    [storedSuppliers, data.selectedSuppliers]
  );
  const [items] = useItems();
  const [approvalKey, setApprovalKey] = useState(() => crypto.randomUUID());
  const submittedReview = useRef<string | null>(null);
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.success &&
      submittedReview.current !== null
    ) {
      if (submittedReview.current === JSON.stringify(review)) setDirty(false);
      submittedReview.current = null;
    }
  }, [fetcher.state, fetcher.data, review]);
  useEffect(() => {
    if (!dirty) {
      setReview(data.review);
      setBaseRevision(data.intake.revision);
    }
  }, [data.review, data.intake.revision, dirty]);
  const reviewForPermissions = (value: InvoiceIntakeReview) =>
    data.permissions.canUpdateSupplier
      ? value
      : {
          ...value,
          header: { ...value.header, rememberSupplier: false },
          lines: value.lines.map((line) => ({
            ...line,
            review: { ...line.review, rememberMatch: false }
          }))
        };
  const change = (value: InvoiceIntakeReview) => {
    setReview(reviewForPermissions(value));
    setDirty(true);
    setApprovalKey(crypto.randomUUID());
  };
  const header = (patch: Partial<InvoiceIntakeReview["header"]>) =>
    change({ ...review, header: { ...review.header, ...patch } });
  const completed = ["Approved", "Linked"].includes(data.intake.status);
  const readOnly =
    completed ||
    data.intake.status === "Ignored" ||
    !data.permissions.canUpdate;
  const conflict = dirty && baseRevision !== data.intake.revision;
  const distinctSources = useMemo(() => {
    const sources = new Map<string, InvoiceReviewSource>();
    for (const source of data.sources) {
      if (
        (completed
          ? data.signedSources.some((approved) => approved.id === source.id)
          : data.eligibleSourceIds.includes(source.id)) &&
        source.sha256 &&
        source.storagePath &&
        !sources.has(source.sha256)
      )
        sources.set(source.sha256, { ...source, sha256: source.sha256 });
    }
    return [...sources.values()];
  }, [data.sources, data.eligibleSourceIds, data.signedSources, completed]);
  const primarySha256 =
    review.header.primarySourceSha256 ??
    (distinctSources.length === 1 ? distinctSources[0].sha256 : null);
  const paymentReconciliation = useMemo(
    () =>
      getInvoicePaymentReconciliation(
        review.header,
        data.payments,
        data.currencies.find(
          (currency) => currency.value === data.payments[0]?.currencyCode
        )?.decimalPlaces ?? null
      ),
    [review.header, data.payments, data.currencies]
  );
  const paymentReviewBasisChanged =
    review.header.total !== data.review.header.total ||
    review.header.currencyCode !== data.review.header.currencyCode;
  const paymentReasonCurrent =
    !paymentReviewBasisChanged &&
    review.header.paymentReviewFingerprint === data.paymentEvidenceFingerprint;
  const paymentIssues =
    review.mergeMode !== "evidence" &&
    ["difference", "unsettled"].includes(paymentReconciliation.status) &&
    (!review.header.paymentReviewReason?.trim() || !paymentReasonCurrent)
      ? [
          {
            path: "header.paymentReviewReason",
            code: "payment",
            message: t`Explain the payment difference or status before approval`
          }
        ]
      : [];
  if (paymentReconciliation.status === "currencyMismatch")
    paymentIssues.push({
      path: "header.currencyCode",
      code: "payment",
      message: t`Payments cannot be linked to an invoice in a different currency`
    });
  const sourceIssues = useMemo(() => {
    const issues: { path: string; code: string; message: string }[] = [];
    if (
      distinctSources.length &&
      !distinctSources.some((source) => source.sha256 === primarySha256)
    )
      issues.push({
        path: "header.primarySourceSha256",
        code: "source",
        message: t`Choose the invoice document to parse`
      });
    const acknowledged = new Set(
      review.header.sourceAcknowledgements
        .filter((entry) => entry.reason.trim())
        .map((entry) => entry.sha256)
    );
    if (
      distinctSources.some(
        (source) =>
          source.sha256 !== primarySha256 && !acknowledged.has(source.sha256)
      )
    )
      issues.push({
        path: "header.sourceAcknowledgements",
        code: "source",
        message: t`Review every other attachment and enter a reason`
      });
    if (
      primarySha256 &&
      !acknowledged.has(primarySha256) &&
      data.sourceCoverage.extractionSha256 &&
      data.sourceCoverage.extractionSha256 !== primarySha256
    )
      issues.push({
        path: "header.sourceAcknowledgements",
        code: "source",
        message: t`Parse the selected invoice or explain your manual review of its facts`
      });
    if (
      data.pendingExtractionReviewId &&
      review.header.extractionReviewId !== data.pendingExtractionReviewId
    )
      issues.push({
        path: "header.extractionReviewId",
        code: "source",
        message: t`Review the new extraction against your saved corrections before approval`
      });
    if (
      data.payments.some((payment) =>
        payment.unresolvedAttachments.some(
          (attachment) =>
            !invoiceReceiptReason(
              review.header.receiptAcknowledgements,
              payment.id,
              attachment.id,
              attachment.fingerprint
            )?.trim()
        )
      )
    )
      issues.push({
        path: "header.receiptAcknowledgements",
        code: "source",
        message: t`Enter a review reason for every unreadable attachment`
      });
    if (
      review.mergeMode !== "evidence" &&
      data.extraction?.lines.some(
        (line) =>
          !review.lines.some((current) => current.lineKey === line.lineKey) &&
          !review.header.excludedLines.some(
            (excluded) =>
              excluded.lineKey === line.lineKey && excluded.reason.trim()
          )
      )
    )
      issues.push({
        path: "header.excludedLines",
        code: "source",
        message: t`Add each extracted source line to the review or exclude it with a reason`
      });
    return issues;
  }, [
    distinctSources,
    primarySha256,
    review.header.sourceAcknowledgements,
    review.header.receiptAcknowledgements,
    review.header.extractionReviewId,
    review.header.excludedLines,
    review.lines,
    review.mergeMode,
    data.payments,
    data.pendingExtractionReviewId,
    data.extraction,
    data.sourceCoverage.extractionSha256,
    t
  ]);
  const localValidation = useMemo(
    () =>
      getInvoiceReviewReadiness(review, {
        ...data.reviewContext,
        supplierAllowed: suppliers.some(
          (supplier) =>
            supplier.id === review.supplierId &&
            supplier.supplierStatus === "Active"
        ),
        currencyDecimalPlaces:
          data.currencies.find(
            (currency) => currency.value === review.header.currencyCode
          )?.decimalPlaces ?? null,
        items: new Map([
          ...items.map((item) => [item.id, item] as const),
          ...data.reviewContext.items
        ]),
        validateNewItem: (proposal) => {
          const result = nativeItemValidators[proposal.type].safeParse(
            proposal.data
          );
          return result.success
            ? []
            : result.error.issues.map((issue) => issue.message);
        },
        validateNewSupplier: (proposal) => {
          const result = supplierValidator.safeParse(proposal.supplier);
          return result.success
            ? []
            : result.error.issues.map((issue) => issue.message);
        }
      }),
    [review, data.reviewContext, data.currencies, items, suppliers]
  );
  // Server validation additionally checks extraction line coverage and custom
  // references. Recheck those against the saved selection after each save.
  const validation = dirty
    ? {
        ...localValidation,
        ready:
          localValidation.ready &&
          sourceIssues.length === 0 &&
          paymentIssues.length === 0,
        issues: [...localValidation.issues, ...sourceIssues, ...paymentIssues]
      }
    : data.validation;
  const unmappedInvoiceLines =
    review.mergeMode === "merge"
      ? data.invoiceLines.filter(
          (line) =>
            data.reviewContext.existingFinancialLineIds?.includes(line.value) &&
            !review.lines.some(
              (current) => current.purchaseInvoiceLineId === line.value
            )
        )
      : [];
  const activeSource = selectInvoicePreviewSource(
    data.signedSources,
    sourceId,
    primarySha256
  );
  const sourceSupplierName =
    data.extraction?.supplier.name.value ?? review.header.sourceSupplierName;
  const extractionIssues = [
    ...new Set([
      ...review.header.sourceIssues,
      ...(data.extraction?.issues ?? [])
    ])
  ];
  const [previewSource, setPreviewSource] = useState(activeSource);
  useEffect(() => {
    // Retain a signed preview through status polling; repeatedly navigating a
    // PDF iframe interrupts review and restarts the browser's PDF renderer.
    const refresh = refreshPreview.current;
    setPreviewSource((previous) =>
      previous?.id === activeSource?.id && previous?.url && !refresh
        ? previous
        : activeSource
    );
    refreshPreview.current = false;
  }, [activeSource]);
  useEffect(() => {
    const timer = setInterval(
      () => {
        refreshPreview.current = true;
        revalidator.revalidate();
      },
      8 * 60 * 1000
    );
    return () => clearInterval(timer);
  }, [revalidator.revalidate]);
  const busy = fetcher.state !== "idle";
  const submit = (
    action:
      | "save"
      | "approve"
      | "link"
      | "retry"
      | "ignore"
      | "restore"
      | "suggest"
  ) => {
    if (busy) return;
    const submitted = reviewForPermissions(review);
    submittedReview.current = ["save", "approve", "link"].includes(action)
      ? JSON.stringify(submitted)
      : null;
    if (submitted !== review) setReview(submitted);
    fetcher.submit(
      JSON.stringify({
        action,
        expectedRevision: baseRevision,
        approvalKey,
        ...(["save", "approve", "link"].includes(action)
          ? { review: submitted }
          : {})
      }),
      {
        method: "post",
        action: path.to.invoiceIntakeAction(data.intake.id),
        encType: "application/json"
      }
    );
  };
  return (
    <div className="w-full p-4 space-y-4">
      <HStack className="justify-between">
        <Heading>
          <Trans>Review invoice document</Trans>
        </Heading>
        <Badge>{statusLabel(data.intake.status)}</Badge>
      </HStack>
      <InvoicePaymentEvidence
        payments={data.payments}
        reconciliation={paymentReconciliation}
        requireExplanation={review.mergeMode !== "evidence"}
        reason={review.header.paymentReviewReason}
        reasonCurrent={paymentReasonCurrent}
        reasonEvidencePending={paymentReviewBasisChanged}
        receiptAcknowledgements={review.header.receiptAcknowledgements}
        onReceiptAcknowledgementsChange={(receiptAcknowledgements) =>
          header({ receiptAcknowledgements })
        }
        onReasonChange={(paymentReviewReason) =>
          header({
            paymentReviewReason,
            paymentReviewFingerprint: data.paymentEvidenceFingerprint
          })
        }
        disabled={readOnly || busy}
      />
      <InvoiceAttachmentStatus status={data.intake.attachmentStatus} />
      <HStack>
        <Button variant="secondary" asChild>
          <Link to={path.to.invoiceDocuments}>
            <Trans>All documents</Trans>
          </Link>
        </Button>
        {data.intake.purchaseInvoiceId && (
          <Button asChild>
            <Link to={path.to.purchaseInvoice(data.intake.purchaseInvoiceId)}>
              <Trans>Open invoice</Trans>
            </Link>
          </Button>
        )}
      </HStack>
      {review.historical && (
        <p className="rounded border p-3 text-sm">
          <Trans>
            This is a historical purchase. Document approval creates a draft or
            links evidence. Receiving inventory, accounting, and payment
            reconciliation remain separate actions.
          </Trans>
        </p>
      )}
      {fetcher.data?.error && (
        <p role="alert" className="text-destructive">
          {fetcher.data.error}
        </p>
      )}
      {data.intake.lastErrorCode &&
        data.intake.lastErrorCode !== "invoice_extraction_review_preserved" && (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>
              Automatic processing needs attention. Check the available
              documents and review fields below before retrying parsing.
            </Trans>
          </p>
        )}
      {data.readinessPending && (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>
            Checking the parsed document against your supplier and item
            settings.
          </Trans>
        </p>
      )}
      {data.pendingExtractionReviewId && !readOnly && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p role="status">
              <Trans>
                A new extraction is available. Your saved corrections and
                proposals were preserved. Compare the extracted facts below with
                your review, including added or changed source lines.
              </Trans>
            </p>
            <InvoiceToggle
              label={t`I reviewed the new extraction against my saved corrections`}
              checked={
                review.header.extractionReviewId ===
                data.pendingExtractionReviewId
              }
              onChange={(checked) =>
                header({
                  extractionReviewId: checked
                    ? data.pendingExtractionReviewId
                    : null
                })
              }
              disabled={busy || !data.extraction}
            />
          </CardContent>
        </Card>
      )}
      {!readOnly &&
        !data.extraction &&
        !data.readinessPending &&
        !["Queued", "Processing"].includes(data.intake.status) && (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>
              No current receipt has been parsed. Saved values may come from an
              earlier document. Parse the selected receipt or check its details
              manually before approval.
            </Trans>
          </p>
        )}
      {conflict && (
        <Card>
          <CardContent className="pt-4 space-y-2">
            <p role="alert">
              <Trans>
                The document changed while you were editing. Your unsaved edits
                are still here. Reload the latest saved review before
                submitting.
              </Trans>
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                setDirty(false);
                setReview(data.review);
                setBaseRevision(data.intake.revision);
              }}
            >
              <Trans>Reload saved review</Trans>
            </Button>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-6 xl:grid-cols-2 items-start">
        <div className="space-y-3 xl:sticky xl:top-4">
          <InvoiceDocumentSourceReview
            sources={distinctSources}
            primarySha256={primarySha256}
            extractionSha256={data.sourceCoverage.extractionSha256}
            header={review.header}
            disabled={readOnly || busy}
            onPrimaryChange={(sha256) => {
              if (sha256 === primarySha256) return;
              header({
                primarySourceSha256: sha256,
                sourceAcknowledgements:
                  review.header.sourceAcknowledgements.filter(
                    (entry) =>
                      entry.sha256 !== sha256 && entry.sha256 !== primarySha256
                  )
              });
              const source = distinctSources.find(
                (entry) => entry.sha256 === sha256
              );
              if (source) setSourceId(source.id);
            }}
            onAcknowledgementsChange={(sourceAcknowledgements) =>
              header({ sourceAcknowledgements })
            }
          />
          {data.signedSources.length > 0 && (
            <InvoiceChoiceField
              label={t`Preview document`}
              value={activeSource?.id ?? null}
              options={data.signedSources.map((source) => ({
                value: source.id,
                label: source.archived
                  ? `${t`Archived`} · ${source.fileName ?? t`Receipt or invoice`}`
                  : (source.fileName ?? t`Receipt or invoice`)
              }))}
              onChange={(id) => setSourceId(id ?? "")}
            />
          )}
          {activeSource?.archived && (
            <Badge>
              <Trans>Archived</Trans>
            </Badge>
          )}
          {activeSource?.url ? (
            <>
              <Button variant="link" asChild>
                <a href={activeSource.url} target="_blank" rel="noreferrer">
                  <Trans>Open original document</Trans>
                </a>
              </Button>
              {activeSource.mediaType === "application/pdf" ? (
                <iframe
                  title={t`Original invoice document`}
                  src={
                    previewSource?.id === activeSource.id
                      ? (previewSource.url ?? activeSource.url)
                      : activeSource.url
                  }
                  className="w-full h-[75dvh] rounded border"
                />
              ) : (
                <img
                  src={activeSource.url}
                  alt={t`Original invoice document`}
                  className="w-full rounded border"
                />
              )}
            </>
          ) : (
            <Card>
              <CardContent className="pt-4">
                {activeSource ? (
                  <>
                    <p>
                      <strong>
                        {activeSource.fileName ?? t`Receipt or invoice`}
                      </strong>
                    </p>
                    <p>
                      <Trans>
                        This document is attached, but its preview is
                        unavailable. Refresh to try opening it again.
                      </Trans>
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        refreshPreview.current = true;
                        revalidator.revalidate();
                      }}
                    >
                      <Trans>Refresh document</Trans>
                    </Button>
                  </>
                ) : (
                  <>
                    <p>
                      <Trans>
                        No eligible receipt or invoice is attached yet. Upload
                        the original document or find its receipt in Mercury.
                      </Trans>
                    </p>
                    {data.payments.length > 0 && (
                      <Button variant="link" asChild>
                        <Link to={path.to.mercuryPayments}>
                          <Trans>Open Mercury payments</Trans>
                        </Link>
                      </Button>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}
          {data.sources.some((source) => source.kind === "gmail") && (
            <p className="text-sm text-muted-foreground">
              <Trans>
                Gmail candidates are retained for later review. They are not
                used to parse or approve this purchase.
              </Trans>
            </p>
          )}
          {!readOnly && (
            <form
              method="post"
              encType="multipart/form-data"
              action={path.to.invoiceIntakeUpload}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                fetcher.submit(form, {
                  method: "post",
                  encType: "multipart/form-data",
                  action: path.to.invoiceIntakeUpload
                });
              }}
              className="space-y-2"
            >
              <input type="hidden" name="intakeId" value={data.intake.id} />
              <input type="hidden" name="sourceKey" value={approvalKey} />
              <input
                type="file"
                name="file"
                aria-label={t`Add supporting document`}
                accept="application/pdf,image/png,image/jpeg"
                required
              />
              <Button
                type="submit"
                variant="secondary"
                isLoading={fetcher.state !== "idle"}
              >
                <Trans>Add supporting document</Trans>
              </Button>
            </form>
          )}
          {data.extraction && (
            <InvoiceExtractionFacts
              extraction={data.extraction}
              review={review}
              pendingReview={!!data.pendingExtractionReviewId}
              disabled={readOnly || busy || review.mergeMode === "evidence"}
              onAdd={(lineKey) => {
                const line = extractionToInvoiceReview(
                  data.extraction!
                ).lines.find((line) => line.lineKey === lineKey);
                if (
                  !line ||
                  review.lines.some((current) => current.lineKey === lineKey)
                )
                  return;
                change({
                  ...review,
                  lines: [
                    ...review.lines,
                    {
                      ...line,
                      sortOrder:
                        review.lines.reduce(
                          (maximum, current) =>
                            Math.max(maximum, current.sortOrder),
                          -1
                        ) + 1
                    }
                  ],
                  header: {
                    ...review.header,
                    excludedLines: review.header.excludedLines.filter(
                      (line) => line.lineKey !== lineKey
                    )
                  }
                });
              }}
              onExclude={(lineKey, reason) =>
                header({
                  excludedLines: [
                    ...review.header.excludedLines.filter(
                      (line) => line.lineKey !== lineKey
                    ),
                    { lineKey, reason }
                  ]
                })
              }
            />
          )}
        </div>
        <div className="space-y-4 min-w-0">
          <Card>
            <CardHeader>
              <CardTitle>
                <Trans>Supplier and invoice</Trans>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {sourceSupplierName && (
                <div className="rounded border p-3 space-y-1">
                  <p className="text-sm text-muted-foreground">
                    <Trans>Vendor on document</Trans>
                  </p>
                  <p className="font-medium">{sourceSupplierName}</p>
                  {data.extraction && (
                    <>
                      <p>
                        {[
                          data.extraction.supplier.addressLine1.value,
                          data.extraction.supplier.addressLine2.value,
                          data.extraction.supplier.city.value,
                          data.extraction.supplier.state.value,
                          data.extraction.supplier.postalCode.value,
                          data.extraction.supplier.countryCode.value
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                      <p>
                        {[
                          data.extraction.supplier.email.value,
                          data.extraction.supplier.phone.value
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {data.extraction.supplier.taxId.value && (
                        <p>
                          <Trans>Tax ID</Trans>:{" "}
                          {data.extraction.supplier.taxId.value}
                        </p>
                      )}
                    </>
                  )}
                  {!review.supplierId && !review.newSupplier && (
                    <p className="text-sm">
                      <Trans>
                        Select an existing supplier or propose this vendor as a
                        new supplier.
                      </Trans>
                    </p>
                  )}
                </div>
              )}
              <InvoiceChoiceField
                label={t`Document kind`}
                value={review.documentKind}
                options={[
                  { value: "invoice", label: t`Invoice` },
                  { value: "receipt", label: t`Receipt` },
                  { value: "credit", label: t`Credit note` },
                  { value: "statement", label: t`Statement` },
                  {
                    value: "paymentConfirmation",
                    label: t`Payment confirmation`
                  },
                  { value: "multiple", label: t`Multiple invoices` },
                  { value: "unknown", label: t`Unknown` }
                ]}
                onChange={(documentKind) =>
                  change({
                    ...review,
                    documentKind:
                      documentKind as InvoiceIntakeReview["documentKind"]
                  })
                }
                disabled={readOnly}
              />
              <InvoiceChoiceField
                label={t`Supplier`}
                value={review.supplierId}
                options={suppliers.map((supplier) => ({
                  value: supplier.id,
                  label: supplier.name
                }))}
                onChange={(supplierId) =>
                  change({ ...review, supplierId, newSupplier: null })
                }
                disabled={readOnly}
              />
              {data.modelSuggestions?.supplierId && (
                <div className="rounded border p-3 space-y-2">
                  <p>
                    <Trans>Suggested supplier:</Trans>{" "}
                    {suppliers.find(
                      (supplier) =>
                        supplier.id === data.modelSuggestions?.supplierId
                    )?.name ?? t`Unavailable supplier`}
                  </p>
                  <Button
                    variant="secondary"
                    isDisabled={readOnly}
                    onClick={() =>
                      change({
                        ...review,
                        supplierId: data.modelSuggestions!.supplierId,
                        newSupplier: null
                      })
                    }
                  >
                    <Trans>Use suggested supplier</Trans>
                  </Button>
                </div>
              )}
              {review.newSupplier && (
                <p>
                  <Trans>New supplier proposed:</Trans>{" "}
                  {String(review.newSupplier.supplier.name ?? "")}
                </p>
              )}
              <Button
                variant="secondary"
                isDisabled={readOnly || !data.permissions.canCreateSupplier}
                onClick={() => setSupplierProposalOpen(true)}
              >
                {review.newSupplier
                  ? t`Edit supplier proposal`
                  : t`Propose new supplier`}
              </Button>
              {review.newSupplier && (
                <div className="grid gap-3 md:grid-cols-2">
                  <InvoiceTextField
                    label={t`Supplier email`}
                    type="email"
                    value={
                      String(review.newSupplier.contact?.email ?? "") || null
                    }
                    onChange={(email) =>
                      change({
                        ...review,
                        newSupplier: {
                          ...review.newSupplier!,
                          contact: email
                            ? { ...review.newSupplier!.contact, email }
                            : undefined
                        }
                      })
                    }
                    disabled={readOnly}
                  />
                  <InvoiceTextField
                    label={t`Tax ID`}
                    value={String(review.newSupplier.tax?.taxId ?? "") || null}
                    disabled={readOnly}
                    onChange={(taxId) =>
                      change({
                        ...review,
                        newSupplier: {
                          ...review.newSupplier!,
                          tax: taxId
                            ? { ...review.newSupplier!.tax, taxId }
                            : undefined
                        }
                      })
                    }
                  />
                  <InvoiceTextField
                    label={t`Address line 1`}
                    value={
                      String(review.newSupplier.address?.addressLine1 ?? "") ||
                      null
                    }
                    onChange={(addressLine1) =>
                      change({
                        ...review,
                        newSupplier: {
                          ...review.newSupplier!,
                          address: {
                            ...review.newSupplier!.address,
                            name: "Invoice address",
                            addressLine1: addressLine1 ?? ""
                          }
                        }
                      })
                    }
                    disabled={readOnly}
                  />
                  {(
                    [
                      "addressLine2",
                      "city",
                      "stateProvince",
                      "postalCode"
                    ] as const
                  ).map((key) => (
                    <InvoiceTextField
                      key={key}
                      label={addressLabels[key]}
                      value={
                        String(review.newSupplier?.address?.[key] ?? "") || null
                      }
                      onChange={(value) =>
                        change({
                          ...review,
                          newSupplier: {
                            ...review.newSupplier!,
                            address: {
                              ...review.newSupplier!.address,
                              name: "Invoice address",
                              [key]: value ?? ""
                            }
                          }
                        })
                      }
                      disabled={readOnly}
                    />
                  ))}
                  <InvoiceChoiceField
                    label={t`Country`}
                    value={
                      String(review.newSupplier.address?.countryCode ?? "") ||
                      null
                    }
                    options={[
                      ...countries,
                      ...(review.newSupplier.address?.countryCode &&
                      !countries.some(
                        (country) =>
                          country.value ===
                          review.newSupplier!.address!.countryCode
                      )
                        ? [
                            {
                              value: String(
                                review.newSupplier.address.countryCode
                              ),
                              label: String(
                                review.newSupplier.address.countryCode
                              )
                            }
                          ]
                        : [])
                    ]}
                    onChange={(countryCode) =>
                      change({
                        ...review,
                        newSupplier: {
                          ...review.newSupplier!,
                          address: {
                            ...review.newSupplier!.address,
                            name: "Invoice address",
                            countryCode: countryCode ?? ""
                          }
                        }
                      })
                    }
                    disabled={readOnly}
                  />
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <InvoiceTextField
                  label={t`Invoice number`}
                  value={review.header.invoiceNumber}
                  onChange={(invoiceNumber) => header({ invoiceNumber })}
                  disabled={readOnly}
                />
                <InvoiceTextField
                  label={t`Invoice date`}
                  type="date"
                  value={review.header.issueDate}
                  onChange={(issueDate) => header({ issueDate })}
                  disabled={readOnly}
                />
                <InvoiceTextField
                  label={t`Due date`}
                  type="date"
                  value={review.header.dueDate}
                  onChange={(dueDate) => header({ dueDate })}
                  disabled={readOnly}
                />
                <InvoiceChoiceField
                  label={t`Currency`}
                  value={review.header.currencyCode}
                  options={data.currencies}
                  onChange={(currencyCode) =>
                    header({ currencyCode, exchangeRate: null })
                  }
                  disabled={readOnly}
                />
                <InvoiceDecimalField
                  label={t`Historical exchange rate`}
                  value={review.header.exchangeRate}
                  onChange={(exchangeRate) => header({ exchangeRate })}
                  disabled={readOnly}
                />
                <InvoiceChoiceField
                  label={t`Invoice location`}
                  value={review.locationId}
                  options={data.locations}
                  onChange={(locationId) => change({ ...review, locationId })}
                  disabled={readOnly}
                />
                <InvoiceChoiceField
                  label={t`Payment terms`}
                  value={review.paymentTermId}
                  options={data.paymentTerms}
                  onChange={(paymentTermId) =>
                    change({ ...review, paymentTermId })
                  }
                  disabled={readOnly}
                />
              </div>
              <InvoiceToggle
                label={t`The receipt has no invoice number`}
                checked={review.header.noInvoiceNumberConfirmed}
                onChange={(noInvoiceNumberConfirmed) =>
                  header({ noInvoiceNumberConfirmed })
                }
                disabled={readOnly}
              />
              <InvoiceToggle
                label={t`Remember this supplier name after approval`}
                checked={
                  data.permissions.canUpdateSupplier &&
                  review.header.rememberSupplier
                }
                onChange={(rememberSupplier) => header({ rememberSupplier })}
                disabled={readOnly || !data.permissions.canUpdateSupplier}
              />
              {!data.permissions.canUpdateSupplier && (
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Purchasing update permission is required to save recognition
                    rules.
                  </Trans>
                </p>
              )}
              <InvoiceToggle
                label={t`Historical purchase`}
                checked={review.historical}
                onChange={(historical) => change({ ...review, historical })}
                disabled={readOnly}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <Trans>Document totals and charges</Trans>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <InvoiceDecimalField
                  label={t`Source subtotal before discounts`}
                  value={review.header.subtotal}
                  onChange={(subtotal) => header({ subtotal })}
                  disabled={readOnly}
                />
                <InvoiceDecimalField
                  label={t`Source discount total`}
                  value={review.header.discount}
                  onChange={(discount) => header({ discount })}
                  disabled={readOnly}
                />
                <InvoiceDecimalField
                  label={t`Source tax total`}
                  value={review.header.tax}
                  onChange={(tax) => header({ tax })}
                  disabled={readOnly}
                />
                <InvoiceDecimalField
                  label={t`Shipping not allocated to lines`}
                  value={review.header.shipping}
                  onChange={(shipping) => header({ shipping })}
                  disabled={readOnly}
                />
                <InvoiceDecimalField
                  label={t`Source document total`}
                  value={review.header.total}
                  onChange={(total) => header({ total })}
                  disabled={readOnly}
                />
              </div>
              <InvoiceToggle
                label={t`Tax, discounts, and shipping are represented correctly`}
                checked={review.header.chargesConfirmed}
                onChange={(chargesConfirmed) => header({ chargesConfirmed })}
                disabled={readOnly}
              />
              {extractionIssues.length > 0 && (
                <>
                  <ul className="list-disc pl-5">
                    {extractionIssues.map((issue, index) => (
                      <li key={`${index}-${issue}`}>{issue}</li>
                    ))}
                  </ul>
                  <InvoiceToggle
                    label={t`I resolved these extraction issues and checked all source lines`}
                    checked={review.header.resolvedSourceIssues}
                    onChange={(resolvedSourceIssues) =>
                      header({ resolvedSourceIssues })
                    }
                    disabled={readOnly}
                  />
                </>
              )}
            </CardContent>
          </Card>
          {(data.invoiceOptions.length > 0 || review.purchaseInvoiceId) && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <Trans>Existing invoice</Trans>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <InvoiceChoiceField
                  label={t`Link existing invoice`}
                  value={review.purchaseInvoiceId}
                  options={data.invoiceOptions.map((invoice) => ({
                    ...invoice,
                    label: `${invoice.label} · ${invoice.status}`
                  }))}
                  onChange={(purchaseInvoiceId) =>
                    change({
                      ...review,
                      purchaseInvoiceId,
                      mergeMode: purchaseInvoiceId ? "evidence" : "new",
                      newSupplier: null,
                      lines: review.lines.map((line) => ({
                        ...line,
                        newItem: null
                      }))
                    })
                  }
                  disabled={readOnly}
                />
                <InvoiceChoiceField
                  label={t`Review action`}
                  value={review.mergeMode}
                  options={[
                    { value: "new", label: t`Create draft` },
                    { value: "enrich", label: t`Fill empty draft` },
                    {
                      value: "merge",
                      label: t`Merge explicitly selected draft lines`
                    },
                    { value: "evidence", label: t`Link evidence only` }
                  ]}
                  onChange={(mergeMode) =>
                    change({
                      ...review,
                      mergeMode: mergeMode as InvoiceIntakeReview["mergeMode"],
                      ...(mergeMode === "evidence"
                        ? {
                            newSupplier: null,
                            lines: review.lines.map((line) => ({
                              ...line,
                              newItem: null
                            }))
                          }
                        : {}),
                      expectedInvoiceUpdatedAt:
                        data.linkedInvoice?.updatedAt ?? null
                    })
                  }
                  disabled={readOnly}
                />
                <InvoiceTextField
                  label={t`Reason this is a different purchase despite a duplicate warning`}
                  value={review.header.duplicateOverrideReason}
                  onChange={(duplicateOverrideReason) =>
                    header({ duplicateOverrideReason })
                  }
                  disabled={readOnly}
                />
                {unmappedInvoiceLines.length > 0 && (
                  <div
                    role="status"
                    className="rounded border p-3 space-y-2 text-sm"
                  >
                    <p>
                      <Trans>
                        Map every existing draft financial line before merging.
                        These lines are not yet mapped to a reviewed receipt
                        line:
                      </Trans>
                    </p>
                    <ul className="list-disc pl-5">
                      {unmappedInvoiceLines.map((line) => (
                        <li key={line.value}>{line.label}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          {review.mergeMode !== "evidence" && (
            <InvoiceDocumentLines
              lines={review.lines}
              onChange={(lines) => change({ ...review, lines })}
              onExclude={(lineKey, reason) =>
                change({
                  ...review,
                  lines: review.lines.filter(
                    (line) => line.lineKey !== lineKey
                  ),
                  header: {
                    ...review.header,
                    excludedLines: [
                      ...review.header.excludedLines.filter(
                        (line) => line.lineKey !== lineKey
                      ),
                      { lineKey, reason }
                    ]
                  }
                })
              }
              locations={data.locations}
              units={data.units}
              currencyDecimals={
                data.currencies.find(
                  (currency) => currency.value === review.header.currencyCode
                )?.decimalPlaces ?? null
              }
              accounts={data.accounts}
              assets={data.assets}
              invoiceLines={data.invoiceLines}
              modelSuggestions={data.modelSuggestions?.lines ?? []}
              recognitionRules={data.rules
                .filter((rule) => rule.kind === "itemAlias")
                .map((rule) => ({
                  value: rule.id,
                  label: invoiceRuleLabel(rule.sourceText)
                }))}
              canCreateTypes={data.permissions.canCreateItemTypes}
              selectedItems={data.selectedItems}
              canRemember={data.permissions.canUpdateSupplier}
              canReplaceRule={data.permissions.canUpdateItems}
              readOnly={readOnly}
            />
          )}
          {review.header.excludedLines.length > 0 && (
            <details>
              <summary>
                <Trans>Excluded source lines</Trans>
              </summary>
              <ul>
                {review.header.excludedLines.map((line) => (
                  <li key={line.lineKey}>
                    {line.lineKey}: {line.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <InvoiceRecognitionRules
            intakeId={data.intake.id}
            rules={data.rules}
            permissions={data.permissions}
          />
          <Card>
            <CardHeader>
              <CardTitle>
                <Trans>Approval</Trans>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p>{t`This approval will create ${validation.newSupplierCount} supplier(s) and ${validation.newItemCount} item(s).`}</p>
              <p>
                <Trans>
                  The invoice remains a draft. Inventory and payments are
                  unchanged.
                </Trans>
              </p>
              {!readOnly && !validation.ready && (
                <ul
                  className="list-disc pl-5 text-sm"
                  aria-label={t`Review issues`}
                >
                  {validation.issues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`}>{issue.message}</li>
                  ))}
                </ul>
              )}
              <HStack className="flex-wrap">
                <Button
                  variant="secondary"
                  onClick={() => submit("save")}
                  isDisabled={readOnly || conflict || busy}
                  isLoading={fetcher.state !== "idle"}
                >
                  <Trans>Save review</Trans>
                </Button>
                <Button
                  onClick={() =>
                    submit(review.mergeMode === "evidence" ? "link" : "approve")
                  }
                  isDisabled={
                    readOnly ||
                    busy ||
                    conflict ||
                    !validation.ready ||
                    distinctSources.length === 0 ||
                    data.readinessPending ||
                    !data.permissions.canApprove
                  }
                  isLoading={fetcher.state !== "idle"}
                >
                  {review.mergeMode === "evidence"
                    ? t`Approve evidence link`
                    : t`Approve and create draft`}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => submit("suggest")}
                  isDisabled={readOnly || dirty || busy}
                >
                  <Trans>Suggest matches</Trans>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => submit("retry")}
                  isDisabled={readOnly || dirty || busy || !primarySha256}
                >
                  <Trans>Parse again</Trans>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    submit(
                      data.intake.status === "Ignored" ? "restore" : "ignore"
                    )
                  }
                  isDisabled={
                    !data.permissions.canUpdate ||
                    busy ||
                    ["Approved", "Linked"].includes(data.intake.status)
                  }
                >
                  {data.intake.status === "Ignored"
                    ? t`Restore document`
                    : t`Ignore document`}
                </Button>
              </HStack>
            </CardContent>
          </Card>
        </div>
      </div>
      {supplierProposalOpen && (
        <DeferredMasterCreation.Provider value={true}>
          <SupplierForm
            type="modal"
            initialValues={invoiceSupplierProposalDefaults(
              review,
              data.extraction
            )}
            onClose={() => setSupplierProposalOpen(false)}
            onPropose={(values, form) => {
              const source = data.extraction?.supplier;
              const contact = source?.email.value
                ? {
                    email: source.email.value,
                    workPhone: source.phone.value ?? ""
                  }
                : undefined;
              const address = source?.addressLine1.value
                ? {
                    name: "Invoice address",
                    addressLine1: source.addressLine1.value,
                    addressLine2: source.addressLine2.value ?? "",
                    city: source.city.value ?? "",
                    stateProvince: source.state.value ?? "",
                    postalCode: source.postalCode.value ?? "",
                    countryCode:
                      invoiceCountryCode(source.countryCode.value, countries) ??
                      ""
                  }
                : undefined;
              change({
                ...review,
                supplierId: null,
                newSupplier: {
                  supplier: values,
                  contact: review.newSupplier?.contact ?? contact,
                  address: review.newSupplier?.address ?? address,
                  tax:
                    review.newSupplier?.tax ??
                    (source?.taxId.value
                      ? { taxId: source.taxId.value }
                      : undefined),
                  customFields: setCustomFields(form)
                }
              });
              setSupplierProposalOpen(false);
            }}
          />
        </DeferredMasterCreation.Provider>
      )}
    </div>
  );
}
