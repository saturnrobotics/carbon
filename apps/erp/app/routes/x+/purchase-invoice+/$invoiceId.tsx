import { error } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { VStack } from "@carbon/react";
import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, redirect, useLoaderData, useParams } from "react-router";
import { PanelProvider, ResizablePanels } from "~/components/Layout";
import { getCurrencyByCode } from "~/modules/accounting";
import {
  getCompanyHasOpenCredits,
  getPurchaseInvoice,
  getPurchaseInvoiceAttachments,
  getPurchaseInvoiceDelivery,
  getPurchaseInvoiceLines,
  PurchaseInvoiceHeader
} from "~/modules/invoicing";
import { InvoiceAttachmentStatus } from "~/modules/invoicing/ui/InvoiceDocuments/InvoiceAttachmentStatus";
import PurchaseInvoiceExplorer from "~/modules/invoicing/ui/PurchaseInvoice/PurchaseInvoiceExplorer";
import PurchaseInvoiceProperties from "~/modules/invoicing/ui/PurchaseInvoice/PurchaseInvoiceProperties";
import {
  getSupplier,
  getSupplierInteraction,
  getSupplierInteractionDocuments
} from "~/modules/purchasing/purchasing.service";
import { detailBreadcrumb, type Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: detailBreadcrumb(
    { breadcrumb: msg`Purchasing Invoices`, to: path.to.invoicingPurchasing },
    (data) => data?.purchaseInvoice?.invoiceId
  ),
  module: "invoicing"
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId, companyGroupId } = await requirePermissions(
    request,
    {
      view: "invoicing"
    }
  );

  const { invoiceId } = params;
  if (!invoiceId) throw new Error("Could not find invoiceId");

  const [purchaseInvoice, purchaseInvoiceLines, purchaseInvoiceDelivery] =
    await Promise.all([
      getPurchaseInvoice(client, invoiceId),
      getPurchaseInvoiceLines(client, invoiceId),
      getPurchaseInvoiceDelivery(client, invoiceId)
    ]);

  if (purchaseInvoice.error) {
    throw redirect(
      path.to.invoicingPurchasing,
      await flash(
        request,
        error(purchaseInvoice.error, "Failed to load purchase invoice")
      )
    );
  }

  const [
    supplier,
    interaction,
    files,
    orgHasCredits,
    currency,
    intakeDocuments,
    copiedAttachments
  ] = await Promise.all([
    purchaseInvoice.data?.supplierId
      ? getSupplier(client, purchaseInvoice.data.supplierId)
      : null,
    getSupplierInteraction(client, purchaseInvoice.data.supplierInteractionId!),
    getSupplierInteractionDocuments(
      client,
      companyId,
      purchaseInvoice.data.supplierInteractionId!
    ),
    getCompanyHasOpenCredits(client, companyId, "purchase"),
    purchaseInvoice.data?.currencyCode
      ? getCurrencyByCode(
          client,
          companyGroupId,
          purchaseInvoice.data.currencyCode
        )
      : null,
    client
      .from("invoiceIntake")
      .select("id, historical, attachmentStatus")
      .eq("companyId", companyId)
      .eq("purchaseInvoiceId", invoiceId)
      .in("status", ["Approved", "Linked"]),
    getPurchaseInvoiceAttachments(client, companyId, invoiceId)
  ]);

  return {
    purchaseInvoice: purchaseInvoice.data,
    currency: currency?.data ?? null,
    purchaseInvoiceLines: purchaseInvoiceLines.data ?? [],
    purchaseInvoiceDelivery: purchaseInvoiceDelivery.data,
    files,
    copiedAttachments: copiedAttachments.data,
    interaction: interaction.data,
    supplier: supplier?.data ?? null,
    orgHasCredits,
    intakeDocuments: intakeDocuments.data ?? []
  };
}

export async function action({ request }: ActionFunctionArgs) {
  throw redirect(
    request.headers.get("Referer") ?? new URL(request.url).pathname
  );
}

export default function PurchaseInvoiceRoute() {
  const { intakeDocuments } = useLoaderData<typeof loader>();
  const params = useParams();
  const { invoiceId } = params;
  if (!invoiceId) throw new Error("Could not find invoiceId");

  return (
    <PanelProvider>
      <div className="flex flex-col h-[calc(100dvh-var(--topbar-height)-var(--content-inset))] overflow-hidden w-full">
        <PurchaseInvoiceHeader />
        <div className="flex h-[calc(100dvh-var(--topbar-height)-var(--header-height)-var(--content-inset))] overflow-hidden w-full">
          <div className="flex flex-grow overflow-hidden">
            <ResizablePanels
              explorer={<PurchaseInvoiceExplorer />}
              content={
                <div className="bg-card h-[calc(100dvh-var(--topbar-height)-var(--header-height)-var(--content-inset))] overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-accent w-full">
                  <VStack spacing={4} className="p-4">
                    {intakeDocuments.length > 0 && (
                      <div className="w-full rounded border p-3 space-y-2 text-sm">
                        <p>
                          <Trans>Source documents</Trans>
                        </p>
                        {intakeDocuments.some(
                          (document) => document.historical
                        ) && (
                          <p>
                            <Trans>
                              This invoice documents a historical purchase.
                              Check current stock before receiving inventory;
                              purchase history does not establish today's stock
                              balance.
                            </Trans>
                          </p>
                        )}
                        {intakeDocuments.map((document) => (
                          <div key={document.id}>
                            <Link
                              className="underline"
                              to={path.to.invoiceDocument(document.id)}
                            >
                              <Trans>
                                Open document review and original attachment
                              </Trans>
                            </Link>
                            <InvoiceAttachmentStatus
                              status={document.attachmentStatus}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                    <Outlet />
                  </VStack>
                </div>
              }
              properties={<PurchaseInvoiceProperties key={invoiceId} />}
            />
          </div>
        </div>
      </div>
    </PanelProvider>
  );
}
