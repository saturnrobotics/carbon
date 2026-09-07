import { assertIsPost } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { assertMercuryRequestOrigin } from "~/modules/invoicing/mercury.server";
import { getDatabaseClient } from "~/services/database.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { companyId } = await requirePermissions(request, {
    view: "invoicing"
  });
  const db = getDatabaseClient();
  const invoice = await db
    .selectFrom("purchaseInvoice")
    .select("id")
    .where("companyId", "=", companyId)
    .where("id", "=", params.invoiceId ?? "")
    .executeTakeFirst();
  if (!invoice) throw new Response("Invoice not found", { status: 404 });
  const intake = await db
    .selectFrom("invoiceIntake")
    .select("id")
    .where("companyId", "=", companyId)
    .where("purchaseInvoiceId", "=", invoice.id)
    .where("status", "not in", ["Approved", "Linked", "Ignored"])
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
  return { intakeId: intake?.id ?? null };
}

/** Older clients must not create arbitrary Parts or default unknown purchase values. */
export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  assertMercuryRequestOrigin(request);
  await requirePermissions(request, { update: "invoicing" });
  return data(
    {
      success: false,
      error:
        "Review the source in Invoice Documents to select item classes and confirm quantities, units and prices"
    },
    { status: 409 }
  );
}
