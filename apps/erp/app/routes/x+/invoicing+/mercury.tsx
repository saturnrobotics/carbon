import { assertIsPost, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { flash } from "@carbon/auth/session.server";
import { MercuryImportError } from "@carbon/database/mercury";
import { ValidatedForm, validationError, validator } from "@carbon/form";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Heading,
  HStack,
  Label,
  VStack
} from "@carbon/react";
import { formatDate, formatDateTime } from "@carbon/utils";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData
} from "react-router";
import {
  Boolean as BooleanField,
  Input,
  Select,
  Submit
} from "~/components/Form";
import { usePermissions } from "~/hooks";
import {
  mercuryApprovalValidator,
  mercurySettingsValidator
} from "~/modules/invoicing/invoicing.models";
import {
  approveMercuryReview,
  assertMercuryRequestOrigin,
  getMercuryReviewPage,
  saveMercurySettings,
  setMercuryReviewStatus
} from "~/modules/invoicing/mercury.server";
import { getDatabaseClient } from "~/services/database.server";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`Mercury`,
  to: path.to.mercuryPayments,
  module: "invoicing"
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "invoicing"
  });
  const params = new URL(request.url).searchParams;
  const requestedStatus = params.get("status");
  const status =
    requestedStatus === "Imported" || requestedStatus === "Ignored"
      ? requestedStatus
      : "Pending";
  const requestedOffset = Number(params.get("offset") ?? 0);
  const offset = Number.isSafeInteger(requestedOffset)
    ? Math.max(0, Math.min(requestedOffset, 1000000))
    : 0;
  return {
    ...(await getMercuryReviewPage(client, companyId, status, offset)),
    companyId,
    status,
    offset
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  assertMercuryRequestOrigin(request);
  await requirePermissions(request, { view: "invoicing" });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "settings") {
      const { companyId, userId } = await requirePermissions(request, {
        update: "settings"
      });
      const parsed = await validator(mercurySettingsValidator).validate(form);
      if (parsed.error) return validationError(parsed.error);
      await saveMercurySettings(
        getDatabaseClient(),
        companyId,
        userId,
        parsed.data
      );
      return redirect(
        path.to.mercuryPayments,
        await flash(request, success("Sync settings saved"))
      );
    }
    if (intent === "approve" || intent === "retry-attachments") {
      const { companyId, userId } = await requirePermissions(request, {
        create: ["invoicing", "purchasing"]
      });
      const importId = String(form.get("importId") ?? "");
      if (!importId) throw new MercuryImportError("Payment import is required");
      let approval = { importId } as {
        importId: string;
        supplierId?: string;
        purchaseInvoiceId?: string;
        supplierName?: string;
        supplierEmail?: string;
      };
      if (intent === "approve") {
        const parsed = await validator(mercuryApprovalValidator).validate(form);
        if (parsed.error) return validationError(parsed.error);
        approval = parsed.data;
      } else {
        const existing = await getDatabaseClient()
          .selectFrom("mercuryTransactionImport")
          .select("id")
          .where("id", "=", importId)
          .where("companyId", "=", companyId)
          .where("purchaseInvoiceId", "is not", null)
          .executeTakeFirst();
        if (!existing)
          throw new MercuryImportError(
            "Create the draft invoice before retrying its source files"
          );
      }
      const result = await approveMercuryReview(
        getDatabaseClient(),
        getCarbonServiceRole(),
        { ...approval, companyId, userId }
      );
      return redirect(
        `${path.to.mercuryPayments}?status=Imported`,
        await flash(
          request,
          success(
            result.attachmentError
              ? "Invoice linked. Some source files need another copy attempt."
              : "Invoice linked and source files are ready for review"
          )
        )
      );
    }
    if (intent === "ignore" || intent === "restore") {
      const { companyId, userId } = await requirePermissions(request, {
        update: "invoicing"
      });
      const importId = String(form.get("importId") ?? "");
      if (!importId) throw new MercuryImportError("Payment import is required");
      await setMercuryReviewStatus(
        getDatabaseClient(),
        companyId,
        userId,
        importId,
        intent === "ignore" ? "Ignored" : "Pending"
      );
      return redirect(path.to.mercuryPayments);
    }
    return data({ error: "Unknown payment import action" }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) throw error;
    return data(
      {
        error:
          error instanceof MercuryImportError
            ? error.message
            : "Unable to save this change. Please retry."
      },
      { status: 400 }
    );
  }
}

export default function MercuryPaymentsRoute() {
  const { t } = useLingui();
  const {
    settings,
    imports,
    suppliers,
    invoices,
    connection,
    companyId,
    status,
    offset,
    hasMore
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const permissions = usePermissions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [supplierFilter, setSupplierFilter] = useState<
    string | null | undefined
  >(undefined);
  const canApprove =
    permissions.can("create", "invoicing") &&
    permissions.can("create", "purchasing");
  const selected = selectedId ?? imports[0]?.id;
  const supplierNames = new Map(
    suppliers.map((supplier) => [supplier.id, supplier.name])
  );
  const issueMessage = (code: string) => {
    if (code === "history_import_in_progress")
      return t`Payment history is still being imported. The next hourly run will continue where it stopped.`;
    if (code === "multiple_invoice_matches_review_required")
      return t`Several invoice emails could match this payment. Review the candidates before approving.`;
    if (code === "gmail_search_truncated_review_required")
      return t`There are more possible emails than could be checked automatically. Review the available matches.`;
    if (code === "attachment_limit_review_required")
      return t`This payment has more source files than can be imported automatically. Review the originals.`;
    if (code === "ATTACHMENT_COPY_FAILED")
      return t`Some source files need another copy attempt. Use Retry source files below.`;
    if (code.endsWith("_429"))
      return t`The provider is limiting requests. The next sync will retry.`;
    if (
      code.startsWith("gmail_") &&
      (code.endsWith("_401") || code.endsWith("_403") || code.endsWith("_400"))
    )
      return t`Mailbox authorization needs to be renewed. Reconnect the affected mailbox.`;
    if (
      code.startsWith("mercury_") &&
      (code.endsWith("_401") || code.endsWith("_403"))
    )
      return t`Mercury authorization needs to be renewed. Check the read-only account connection.`;
    if (code === "gmail_mailbox_mismatch")
      return t`A connected mailbox does not match its configured address. Reconnect that mailbox.`;
    return t`The last attempt could not finish. The next sync will retry; the available payment evidence is preserved.`;
  };
  return (
    <div className="w-full overflow-auto p-4 md:p-8 space-y-6">
      <Heading size="h2">
        <Trans>Mercury payments</Trans>
      </Heading>
      {actionData && "error" in actionData && (
        <p role="alert" className="text-destructive">
          {actionData.error}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <Trans>Automatic import</Trans>
          </CardTitle>
          <CardDescription>
            <Trans>
              Check outgoing payments every hour. Proposed suppliers and invoice
              matches wait for your review.
            </Trans>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p>
            {connection.mercuryReady
              ? t`Mercury connection configured`
              : t`The Mercury connection needs one-time setup before syncing can start.`}
          </p>
          {!connection.mercuryReady &&
            permissions.can("update", "settings") && (
              <p className="text-sm text-muted-foreground">
                <Trans>
                  For one-time deployment setup, use this company ID for
                  PAYMENT_SYNC_COMPANY_ID:
                </Trans>{" "}
                <code>{companyId}</code>
              </p>
            )}
          <p className="text-sm text-muted-foreground">
            <Trans>Last successful sync:</Trans>{" "}
            {settings?.lastSuccessAt
              ? formatDateTime(settings.lastSuccessAt)
              : t`Not yet run`}
          </p>
          {settings?.lastError && (
            <p role="status">{issueMessage(settings.lastError)}</p>
          )}
          {settings?.lastGmailError && (
            <p role="status">
              <Trans>Mailbox matching needs attention:</Trans>{" "}
              {issueMessage(settings.lastGmailError)}
            </p>
          )}
          {connection.gmailConfigurationError && (
            <p role="status">
              <Trans>Mailbox configuration needs correction.</Trans>
            </p>
          )}
          <ValidatedForm
            key={settings?.updatedAt ?? "new-settings"}
            method="post"
            validator={mercurySettingsValidator}
            defaultValues={{
              enabled: settings?.enabled ?? false,
              gmailEnabled: settings?.gmailEnabled ?? true,
              syncFromDate: settings?.syncFromDate ?? undefined,
              disabledMailboxes: settings?.disabledMailboxes ?? []
            }}
            isDisabled={!permissions.can("update", "settings")}
            className="space-y-4"
          >
            <input type="hidden" name="intent" value="settings" />
            <BooleanField
              name="enabled"
              label={t`Hourly sync`}
              helperText={t`Turn this off to pause future imports. Existing review records stay available.`}
            />
            <BooleanField
              name="gmailEnabled"
              label={t`Find invoice emails`}
              helperText={t`Search connected mailboxes for invoice evidence and supplier suggestions.`}
            />
            <Input
              name="syncFromDate"
              type="date"
              label={t`Import history from`}
              helperText={t`Leave blank to include all available payment history.`}
            />
            <VStack spacing={2}>
              {connection.mailboxes.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  <Trans>No invoice mailboxes are connected yet.</Trans>
                </p>
              )}
              {connection.mailboxes.map((mailbox, index) => (
                <HStack key={mailbox.email}>
                  <Checkbox
                    id={`pause-mailbox-${index}`}
                    name="disabledMailboxes"
                    value={mailbox.email}
                    defaultChecked={
                      settings?.disabledMailboxes.includes(mailbox.email) ??
                      false
                    }
                    disabled={
                      !mailbox.enabled || !permissions.can("update", "settings")
                    }
                  />
                  <Label htmlFor={`pause-mailbox-${index}`}>
                    <Trans>Pause</Trans> {mailbox.email}
                  </Label>
                  {!mailbox.enabled && (
                    <span className="text-sm text-muted-foreground">
                      <Trans>Disabled in connection setup</Trans>
                    </span>
                  )}
                </HStack>
              ))}
            </VStack>
            <Submit withBlocker={false}>
              <Trans>Save sync settings</Trans>
            </Submit>
          </ValidatedForm>
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground max-w-3xl">
        <Trans>
          Approval links an existing invoice or creates a draft purchase invoice
          and copies its source files. Review new invoice dates, numbers, totals
          and lines before posting. Bank account mapping and payment settlement
          are not configured; these records do not mark invoices as paid.
        </Trans>
      </p>
      <HStack>
        {(["Pending", "Imported", "Ignored"] as const).map((value) => (
          <Button
            asChild
            key={value}
            variant={status === value ? "active" : "secondary"}
          >
            <Link to={`${path.to.mercuryPayments}?status=${value}`}>
              {value === "Pending"
                ? t`Needs review`
                : value === "Imported"
                  ? t`Linked invoices`
                  : t`Ignored`}
            </Link>
          </Button>
        ))}
      </HStack>
      {imports.length === 0 && (
        <p className="text-muted-foreground">
          <Trans>No payments in this view.</Trans>
        </p>
      )}
      {imports.map((record) => (
        <Card key={record.id}>
          <CardHeader>
            <HStack className="justify-between flex-wrap">
              <CardTitle>
                {record.vendorSuggestion.name ||
                  t`Supplier needs identification`}
              </CardTitle>
              <Badge>{record.remoteStatus}</Badge>
            </HStack>
            <CardDescription>
              {record.amount} {record.currencyCode} ·{" "}
              {formatDate(record.transactionDate)}
              {record.reference ? ` · ${record.reference}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {record.memo && (
              <p className="text-sm whitespace-pre-wrap">{record.memo}</p>
            )}
            {record.lastError && (
              <p role="status" className="text-sm">
                {issueMessage(record.lastError)}
              </p>
            )}
            {record.attachments.length > 0 && (
              <ul className="space-y-1 text-sm">
                {record.attachments.map((attachment) => (
                  <li key={attachment.path}>
                    <Link
                      className="underline"
                      to={path.to.file.previewFile(
                        `private/${attachment.path}`
                      )}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {attachment.fileName}
                    </Link>
                    {attachment.mailbox && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {attachment.mailbox}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {record.invoiceEvidence.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm">
                  <Trans>Possible invoice emails</Trans> (
                  {record.invoiceEvidence.length})
                </summary>
                <ul className="mt-2 space-y-3 text-sm">
                  {record.invoiceEvidence.map((evidence) => (
                    <li key={`${evidence.mailbox}:${evidence.messageId}`}>
                      <p>{evidence.subject}</p>
                      <p className="text-muted-foreground">
                        {evidence.from} · {evidence.mailbox}
                      </p>
                      <p className="text-muted-foreground">
                        {evidence.reasons.join("; ")}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {record.purchaseInvoiceId ? (
              <HStack>
                <Button asChild variant="secondary">
                  <Link to={path.to.purchaseInvoice(record.purchaseInvoiceId)}>
                    <Trans>Open invoice</Trans>
                  </Link>
                </Button>
                {record.lastError === "ATTACHMENT_COPY_FAILED" &&
                  canApprove && (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="retry-attachments"
                      />
                      <input type="hidden" name="importId" value={record.id} />
                      <Button type="submit" variant="secondary">
                        <Trans>Retry source files</Trans>
                      </Button>
                    </Form>
                  )}
              </HStack>
            ) : (
              status === "Pending" &&
              canApprove &&
              (selected === record.id ? (
                <ValidatedForm
                  key={record.id}
                  method="post"
                  validator={mercuryApprovalValidator}
                  defaultValues={{
                    importId: record.id,
                    supplierId: record.supplierId ?? undefined,
                    supplierName: record.vendorSuggestion.name || undefined,
                    supplierEmail: record.vendorSuggestion.email ?? undefined
                  }}
                  className="space-y-4 max-w-2xl"
                >
                  <input type="hidden" name="intent" value="approve" />
                  <input type="hidden" name="importId" value={record.id} />
                  <Select
                    name="supplierId"
                    label={t`Existing supplier`}
                    isOptional
                    onChange={(value) =>
                      setSupplierFilter(value?.value ?? null)
                    }
                    options={suppliers.map((supplier) => ({
                      value: supplier.id,
                      label: supplier.name
                    }))}
                  />
                  <Select
                    name="purchaseInvoiceId"
                    label={t`Existing invoice`}
                    isOptional
                    helperText={t`Select the original invoice for an additional or partial payment. Its supplier is reused; leave blank to create a new draft.`}
                    options={invoices
                      .filter(
                        (invoice) =>
                          invoice.currencyCode === record.currencyCode &&
                          (!(supplierFilter === undefined
                            ? record.supplierId
                            : supplierFilter) ||
                            invoice.supplierId ===
                              (supplierFilter === undefined
                                ? record.supplierId
                                : supplierFilter))
                      )
                      .map((invoice) => ({
                        value: invoice.id,
                        label: `${invoice.invoiceId} · ${supplierNames.get(invoice.supplierId ?? "") ?? ""} · ${invoice.status}`
                      }))}
                  />
                  <Input
                    name="supplierName"
                    label={t`New supplier name`}
                    helperText={t`Used only when creating an invoice without an existing supplier or recipient link.`}
                  />
                  <Input
                    name="supplierEmail"
                    type="email"
                    label={t`New supplier email`}
                  />
                  <Submit withBlocker={false}>
                    <Trans>Approve and link invoice</Trans>
                  </Submit>
                </ValidatedForm>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSelectedId(record.id);
                    setSupplierFilter(undefined);
                  }}
                >
                  <Trans>Review supplier</Trans>
                </Button>
              ))
            )}
            {!record.purchaseInvoiceId &&
              permissions.can("update", "invoicing") && (
                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value={status === "Ignored" ? "restore" : "ignore"}
                  />
                  <input type="hidden" name="importId" value={record.id} />
                  <Button type="submit" variant="ghost">
                    {status === "Ignored"
                      ? t`Restore to review`
                      : t`Ignore this payment`}
                  </Button>
                </Form>
              )}
          </CardContent>
        </Card>
      ))}
      <HStack>
        {offset > 0 && (
          <Button asChild variant="secondary">
            <Link
              to={`${path.to.mercuryPayments}?status=${status}&offset=${Math.max(0, offset - 50)}`}
            >
              <Trans>Previous</Trans>
            </Link>
          </Button>
        )}
        {hasMore && (
          <Button asChild variant="secondary">
            <Link
              to={`${path.to.mercuryPayments}?status=${status}&offset=${offset + 50}`}
            >
              <Trans>Next</Trans>
            </Link>
          </Button>
        )}
      </HStack>
    </div>
  );
}
