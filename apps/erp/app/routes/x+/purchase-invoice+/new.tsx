import { assertIsPost, error } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import { msg } from "@lingui/core/macro";
import type { FunctionsResponse } from "@supabase/functions-js";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { useCompanyToday, useUrlParams, useUser } from "~/hooks";
import {
  createPurchaseInvoiceFromPurchaseOrder,
  insertPurchaseInvoice,
  PurchaseInvoiceForm,
  purchaseInvoiceValidator
} from "~/modules/invoicing";
import { getEdgeFunctionErrorMessage } from "~/utils/error";
import { setCustomFields } from "~/utils/form";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`Purchasing`,
  to: path.to.purchasing,
  module: "purchasing"
};

export async function loader({ request }: LoaderFunctionArgs) {
  // we don't use the client here -- if they have this permission, we'll upgrade to a service role if needed
  const { companyId, userId } = await requirePermissions(request, {
    create: "invoicing"
  });

  const url = new URL(request.url);
  const sourceDocument = url.searchParams.get("sourceDocument") ?? undefined;
  const sourceDocumentId = url.searchParams.get("sourceDocumentId") ?? "";

  let result: FunctionsResponse<{ id: string }>;

  switch (sourceDocument) {
    case "Purchase Order":
      if (!sourceDocumentId) throw new Error("Missing sourceDocumentId");
      result = await createPurchaseInvoiceFromPurchaseOrder(
        getCarbonServiceRole(),
        sourceDocumentId,
        companyId,
        userId
      );

      if (result.error || !result?.data) {
        throw redirect(
          request.headers.get("Referer") ?? path.to.purchaseOrders,
          await flash(
            request,
            error(
              result.error,
              await getEdgeFunctionErrorMessage(
                result.error,
                "Failed to create purchase invoice"
              )
            )
          )
        );
      }

      throw redirect(path.to.purchaseInvoice(result.data?.id!));

    default:
      return null;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, companyGroupId, userId } =
    await requirePermissions(request, {
      create: "invoicing"
    });

  const formData = await request.formData();
  const oldExtraction = String(formData.get("extractedLineItems") ?? "").trim();
  if (
    (oldExtraction && oldExtraction !== "[]") ||
    formData.get("extractedStoragePath")
  ) {
    throw redirect(
      path.to.invoiceDocuments,
      await flash(
        request,
        error(
          null,
          "Upload the receipt in Invoice Documents to review its supplier, item classes, units and totals before creating an invoice"
        )
      )
    );
  }
  const validation = await validator(purchaseInvoiceValidator).validate(
    formData
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { id: _id, ...d } = validation.data;

  const result = await insertPurchaseInvoice(client, {
    ...d,
    invoiceId: d.invoiceId || undefined,
    companyId,
    companyGroupId,
    createdBy: userId,
    customFields: setCustomFields(formData)
  });

  if (result.error || !result.data) {
    throw redirect(
      path.to.invoicingPurchasing,
      await flash(
        request,
        error(result.error, "Failed to insert purchase invoice")
      )
    );
  }

  throw redirect(path.to.purchaseInvoice(result.data.id));
}

export default function PurchaseInvoiceNewRoute() {
  const [params] = useUrlParams();
  const supplierId = params.get("supplierId");
  const { defaults } = useUser();

  const companyToday = useCompanyToday();
  const initialValues = {
    id: undefined,
    invoiceId: undefined,
    supplierId: supplierId ?? "",
    locationId: defaults?.locationId ?? "",
    dateIssued: companyToday
  };

  return (
    <div className="max-w-4xl w-full p-2 sm:p-0 mx-auto mt-0 md:mt-8">
      <PurchaseInvoiceForm initialValues={initialValues} />
    </div>
  );
}
