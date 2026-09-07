import { invoiceIntakeStatuses } from "@carbon/jobs";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Heading,
  HStack,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { Link, useFetcher, useNavigate, useRevalidator } from "react-router";
import { path } from "~/utils/path";
import { invoiceIntakeHeaderValidator } from "../../invoicing.models";
import type { getInvoiceIntakeInbox } from "../../invoicing.server";
import { InvoiceAttachmentStatus } from "./InvoiceAttachmentStatus";
import { InvoiceDecimalField, InvoiceToggle } from "./InvoiceDocumentLines";
import { invoiceInboxFacts } from "./invoice-document.utils";
import { useInvoiceDocumentLabels } from "./useInvoiceDocumentLabels";

type InboxData = Awaited<ReturnType<typeof getInvoiceIntakeInbox>> & {
  status: string;
};
export function InvoiceDocumentInbox({ data }: { data: InboxData }) {
  const { t } = useLingui();
  const statusLabel = useInvoiceDocumentLabels();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const upload = useFetcher<{ intakeId?: string; error?: string }>();
  const actions = useFetcher<{
    success?: boolean;
    error?: string;
    results?: { id: string; success: boolean; error?: string }[];
  }>();
  const [selected, setSelected] = useState<string[]>([]);
  const [historical, setHistorical] = useState(false);
  const [settings, setSettings] = useState({
    enabled: data.settings?.enabled ?? false,
    automaticMercuryIntake: data.settings?.automaticMercuryIntake ?? true,
    dailyBudgetUsd: Number(data.settings?.dailyBudgetUsd ?? 5),
    monthlyBudgetUsd: Number(data.settings?.monthlyBudgetUsd ?? 50)
  });
  useEffect(() => {
    if (upload.state === "idle" && upload.data?.intakeId)
      navigate(path.to.invoiceDocument(upload.data.intakeId));
  }, [upload.data, upload.state, navigate]);
  useEffect(() => {
    if (
      !data.intakes.some((intake) =>
        ["Queued", "Processing"].includes(intake.status)
      ) &&
      !["Queued", "Running"].includes(data.settings?.backfillStatus ?? "")
    )
      return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 10000);
    return () => clearInterval(timer);
  }, [data.intakes, data.settings?.backfillStatus, revalidator]);
  const run = (input: object) =>
    actions.submit(JSON.stringify(input), {
      method: "post",
      action: path.to.invoiceDocuments,
      encType: "application/json"
    });
  return (
    <div className="w-full p-4 space-y-4">
      <Heading>
        <Trans>Invoice documents</Trans>
      </Heading>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Upload a receipt or review documents collected from Mercury. Confirm
          suppliers, items, and amounts before creating a draft invoice.
        </Trans>
      </p>
      <Card>
        <CardHeader>
          <CardTitle>
            <Trans>Upload receipt or invoice</Trans>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              form.set("sourceKey", crypto.randomUUID());
              form.set("historical", String(historical));
              upload.submit(form, {
                method: "post",
                action: path.to.invoiceIntakeUpload,
                encType: "multipart/form-data"
              });
            }}
          >
            <input
              type="file"
              name="file"
              aria-label={t`Invoice document`}
              accept="application/pdf,image/png,image/jpeg"
              required
              disabled={
                !data.permissions.canUpdate && !data.permissions.canApprove
              }
            />
            <InvoiceToggle
              label={t`Historical purchase`}
              checked={historical}
              onChange={setHistorical}
            />
            <Button
              type="submit"
              isLoading={upload.state !== "idle"}
              isDisabled={
                !data.permissions.canUpdate && !data.permissions.canApprove
              }
            >
              <Trans>Upload and review</Trans>
            </Button>
            {upload.data?.error && (
              <p role="alert" className="text-destructive">
                {upload.data.error}
              </p>
            )}
          </form>
        </CardContent>
      </Card>
      <HStack className="flex-wrap">
        <Button
          variant={data.status === "Actionable" ? "secondary" : "ghost"}
          asChild
        >
          <Link to={path.to.invoiceDocuments}>
            <Trans>Actionable</Trans>
          </Link>
        </Button>
        <Button variant={data.status === "All" ? "secondary" : "ghost"} asChild>
          <Link to={`${path.to.invoiceDocuments}?status=All`}>
            <Trans>All</Trans>
          </Link>
        </Button>
        {invoiceIntakeStatuses.map((status) => (
          <Button
            key={status}
            variant={data.status === status ? "secondary" : "ghost"}
            asChild
          >
            <Link to={`${path.to.invoiceDocuments}?status=${status}`}>
              {statusLabel(status)}
            </Link>
          </Button>
        ))}
      </HStack>
      <Button
        variant="secondary"
        isDisabled={!selected.length || !data.permissions.canApprove}
        isLoading={actions.state !== "idle"}
        onClick={() =>
          run({
            action: "batch",
            documents: data.intakes
              .filter(
                (intake) =>
                  selected.includes(intake.id) && intake.status === "Ready"
              )
              .map((intake) => ({
                id: intake.id,
                revision: intake.revision,
                approvalKey: crypto.randomUUID()
              }))
          })
        }
      >
        <Trans>Approve selected ready documents</Trans>
      </Button>
      {actions.data?.error && (
        <p role="alert" className="text-destructive">
          {actions.data.error}
        </p>
      )}
      {actions.data?.results && (
        <ul aria-label={t`Approval results`}>
          {actions.data.results.map((result) => (
            <li key={result.id}>
              <Link
                className="underline"
                to={path.to.invoiceDocument(result.id)}
              >
                {result.success ? t`Approved` : result.error}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Table>
        <Thead>
          <Tr>
            <Th>
              <Trans>Select</Trans>
            </Th>
            <Th>
              <Trans>Supplier / reference</Trans>
            </Th>
            <Th>
              <Trans>Date</Trans>
            </Th>
            <Th>
              <Trans>Total</Trans>
            </Th>
            <Th>
              <Trans>Status</Trans>
            </Th>
            <Th>
              <Trans>Review</Trans>
            </Th>
          </Tr>
        </Thead>
        <Tbody>
          {data.intakes.map((intake) => {
            const parsed = invoiceIntakeHeaderValidator.safeParse(
              intake.header
            );
            const header = parsed.success ? parsed.data : null;
            const facts = invoiceInboxFacts(
              header,
              intake.payments,
              intake.status
            );
            return (
              <Tr key={intake.id}>
                <Td>
                  <Checkbox
                    aria-label={t`Select document`}
                    checked={selected.includes(intake.id)}
                    disabled={intake.status !== "Ready"}
                    onCheckedChange={(checked) =>
                      setSelected((previous) =>
                        checked === true
                          ? [...new Set([...previous, intake.id])]
                          : previous.filter((id) => id !== intake.id)
                      )
                    }
                  />
                </Td>
                <Td>
                  {facts.supplier.fromPayment && (
                    <span className="text-xs text-muted-foreground">
                      <Trans>Payment</Trans>:{" "}
                    </span>
                  )}
                  {facts.supplier.value ?? t`Supplier unresolved`}
                  <HStack>
                    {intake.sourceKinds.map((kind) => (
                      <Badge key={kind}>
                        {kind === "upload"
                          ? t`Upload`
                          : kind === "gmail"
                            ? "Gmail"
                            : "Mercury"}
                      </Badge>
                    ))}
                  </HStack>
                  {(intake.newSupplierCount > 0 || intake.newItemCount > 0) && (
                    <p className="text-xs">{t`${intake.newSupplierCount} new supplier(s), ${intake.newItemCount} new item(s)`}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {facts.reference.fromPayment && (
                      <>
                        <Trans>Payment</Trans>:{" "}
                      </>
                    )}
                    {facts.reference.value ?? t`No reference`}
                  </p>
                </Td>
                <Td>
                  {facts.date.fromPayment && (
                    <span className="block text-xs text-muted-foreground">
                      <Trans>Payment</Trans>
                    </span>
                  )}
                  {facts.date.value ?? "—"}
                </Td>
                <Td>
                  {facts.amount.fromPayment && (
                    <span className="block text-xs text-muted-foreground">
                      <Trans>Payment</Trans>
                    </span>
                  )}
                  {facts.amount.value ?? "—"}
                </Td>
                <Td>
                  <Badge>{statusLabel(intake.status)}</Badge>
                  <InvoiceAttachmentStatus status={intake.attachmentStatus} />
                  {intake.historical && (
                    <span className="block text-xs">
                      <Trans>Historical</Trans>
                    </span>
                  )}
                  {intake.lastErrorCode && (
                    <p className="text-xs text-destructive">
                      <Trans>Review or retry parsing</Trans>
                    </p>
                  )}
                </Td>
                <Td>
                  <Button variant="link" asChild>
                    <Link to={path.to.invoiceDocument(intake.id)}>
                      <Trans>Review</Trans>
                    </Link>
                  </Button>
                </Td>
              </Tr>
            );
          })}
          {!data.intakes.length && (
            <Tr>
              <Td colSpan={6}>
                <Trans>No documents in this view.</Trans>
              </Td>
            </Tr>
          )}
        </Tbody>
      </Table>
      <HStack>
        <Button variant="secondary" isDisabled={data.offset === 0} asChild>
          <Link
            to={`${path.to.invoiceDocuments}?status=${data.status}&offset=${Math.max(0, data.offset - 50)}`}
          >
            <Trans>Previous</Trans>
          </Link>
        </Button>
        <Button variant="secondary" isDisabled={!data.hasMore} asChild>
          <Link
            to={`${path.to.invoiceDocuments}?status=${data.status}&offset=${data.offset + 50}`}
          >
            <Trans>Next</Trans>
          </Link>
        </Button>
      </HStack>
      {data.permissions.canSettings && (
        <Card>
          <CardHeader>
            <CardTitle>
              <Trans>Parsing and historical ingestion</Trans>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <InvoiceToggle
              label={t`Enable automatic document parsing`}
              checked={settings.enabled}
              onChange={(enabled) =>
                setSettings((previous) => ({ ...previous, enabled }))
              }
            />
            <InvoiceToggle
              label={t`Collect invoice documents during Mercury sync`}
              checked={settings.automaticMercuryIntake}
              onChange={(automaticMercuryIntake) =>
                setSettings((previous) => ({
                  ...previous,
                  automaticMercuryIntake
                }))
              }
            />
            <div className="grid gap-4 md:grid-cols-2">
              <InvoiceDecimalField
                label={t`Daily parsing allowance (USD)`}
                value={String(settings.dailyBudgetUsd)}
                onChange={(value) =>
                  setSettings((previous) => ({
                    ...previous,
                    dailyBudgetUsd: Number(value ?? 0)
                  }))
                }
              />
              <InvoiceDecimalField
                label={t`Monthly parsing allowance (USD)`}
                value={String(settings.monthlyBudgetUsd)}
                onChange={(value) =>
                  setSettings((previous) => ({
                    ...previous,
                    monthlyBudgetUsd: Number(value ?? 0)
                  }))
                }
              />
            </div>
            <Button
              variant="secondary"
              isLoading={actions.state !== "idle"}
              onClick={() => run({ action: "settings", settings })}
            >
              <Trans>Save parsing settings</Trans>
            </Button>
            <p className="text-sm">
              <Trans>
                Pausing parsing keeps documents and manual review available.
                These allowances control this application's new requests.
              </Trans>
            </p>
            <p>
              <Trans>Historical ingestion:</Trans>{" "}
              {statusLabel(data.settings?.backfillStatus ?? "Idle")}
            </p>
            <p className="text-sm">
              <Trans>Today:</Trans> ${data.budget.todayActualUsd}{" "}
              <Trans>used</Trans>, ${data.budget.todayReservedUsd}{" "}
              <Trans>reserved</Trans>. <Trans>This month:</Trans> $
              {data.budget.monthActualUsd} <Trans>used</Trans>, $
              {data.budget.monthReservedUsd} <Trans>reserved</Trans>.
            </p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {[
                ["processed", t`Payments examined`],
                ["documents", t`Documents collected`],
                ["needsDocument", t`Waiting for documents`],
                ["linked", t`Existing invoice links`],
                ["ignored", t`Ignored payments`]
              ].map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>
                    {Number(
                      (
                        data.settings?.backfillCounts as Record<
                          string,
                          unknown
                        > | null
                      )?.[key!] ?? 0
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <HStack>
              <Button
                variant="secondary"
                onClick={() => run({ action: "backfill", operation: "start" })}
                isDisabled={["Queued", "Running"].includes(
                  data.settings?.backfillStatus ?? ""
                )}
              >
                <Trans>Start historical document ingestion</Trans>
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  run({
                    action: "backfill",
                    operation:
                      data.settings?.backfillStatus === "Paused"
                        ? "resume"
                        : "pause"
                  })
                }
              >
                {data.settings?.backfillStatus === "Paused"
                  ? t`Resume history`
                  : t`Pause history`}
              </Button>
            </HStack>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
