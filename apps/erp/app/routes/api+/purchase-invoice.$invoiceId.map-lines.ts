import { assertIsPost } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
<<<<<<< HEAD
||||||| 85d9006e1
import { getCarbonServiceRole } from "@carbon/auth/client.server";
=======
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { getLogger } from "@carbon/logger";
>>>>>>> 0608ffdc42d0089409e81ee6e8dee290416e4822
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { assertMercuryRequestOrigin } from "~/modules/invoicing/mercury.server";
import { getDatabaseClient } from "~/services/database.server";

const logger = getLogger("erp", "purchase-invoice-map-lines");

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

<<<<<<< HEAD
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
||||||| 85d9006e1
export async function action({ request, params }: ActionFunctionArgs) {
  const { client, companyId, userId } = await requirePermissions(request, {
    update: "invoicing"
  });

  const { invoiceId } = params;
  if (!invoiceId) throw new Error("invoiceId required");

  const formData = await request.formData();
  const mappingsStr = formData.get("mappings") as string;
  if (!mappingsStr) return { success: false, error: "No mappings provided" };

  const mappings = JSON.parse(mappingsStr);
  const serviceRole = await getCarbonServiceRole();

  for (const map of mappings) {
    if (map.action === "ignore") continue;

    let finalItemId = map.itemId;

    if (map.action === "create") {
      // readableId and name are whatever the user typed in the create field,
      // falling back to the extracted description.
      const createName = (map.createName || map.description || "").trim();
      if (!createName) continue;

      // Reuse an existing item with the same readableId instead of failing on
      // the unique constraint / creating a duplicate.
      const existing = await serviceRole
        .from("item")
        .select("id")
        .eq("companyId", companyId)
        .eq("readableId", createName)
        .maybeSingle();

      if (existing.data) {
        finalItemId = existing.data.id;
      } else {
        // Create through the standard Part flow (item + part + companion rows)
        // with the service role, since the invoicing-scoped client can't insert
        // items under RLS. Purchased items default to Buy.
        const created = await upsertPart(serviceRole, {
          id: createName,
          name: createName,
          revision: "0",
          description: map.description || undefined,
          replenishmentSystem: "Buy",
          defaultMethodType: "Pull from Inventory",
          itemTrackingType: "Inventory",
          unitOfMeasureCode: "EA",
          shelfLifeCalculateFromBom: false,
          companyId,
          createdBy: userId
        });

        if (!created.error && created.data?.id) {
          finalItemId = created.data.id;
        }
      }
    }

    if (finalItemId) {
      // Set the line's item and promote it from a Comment to a Part line.
      await client
        .from("purchaseInvoiceLine")
        .update({
          itemId: finalItemId,
          invoiceLineType: "Part",
          updatedBy: userId
        })
        .eq("id", map.lineId);
    }
  }

  return { success: true };
=======
export async function action({ request, params }: ActionFunctionArgs) {
  const { client, companyId, userId } = await requirePermissions(request, {
    update: "invoicing"
  });

  const { invoiceId } = params;
  if (!invoiceId) throw new Error("invoiceId required");

  const formData = await request.formData();
  const mappingsStr = formData.get("mappings") as string;
  if (!mappingsStr) return { success: false, error: "No mappings provided" };

  const mappings = JSON.parse(mappingsStr);
  if (!Array.isArray(mappings)) {
    return { success: false, error: "Invalid mappings" };
  }
  const serviceRole = await getCarbonServiceRole();

  // Every line id and chosen item id is caller-supplied. Prove each line
  // belongs to this invoice in this company, and each item to this company,
  // before any of them is written — otherwise a line could be pointed at
  // another company's item.
  const activeMappings = mappings.filter((map) => map?.action !== "ignore");
  if (activeMappings.some((map) => typeof map?.lineId !== "string")) {
    return { success: false, error: "Invalid mappings" };
  }
  const lineIds = [...new Set(activeMappings.map((map) => map.lineId))];
  const itemIds = [
    ...new Set(
      activeMappings
        .filter((map) => map.itemId)
        .map((map) => String(map.itemId))
    )
  ];

  if (lineIds.length > 0) {
    const lines = await serviceRole
      .from("purchaseInvoiceLine")
      .select("id")
      .eq("invoiceId", invoiceId)
      .eq("companyId", companyId)
      .in("id", lineIds);
    if (lines.error || (lines.data?.length ?? 0) !== lineIds.length) {
      logger.error("Invoice lines not found for mapping", {
        companyId,
        invoiceId,
        lineIds,
        error: lines.error
      });
      return { success: false, error: "Invoice line not found" };
    }
  }

  if (itemIds.length > 0) {
    const items = await serviceRole
      .from("item")
      .select("id")
      .eq("companyId", companyId)
      .in("id", itemIds);
    if (items.error || (items.data?.length ?? 0) !== itemIds.length) {
      logger.error("Items not found for invoice line mapping", {
        companyId,
        invoiceId,
        itemIds,
        error: items.error
      });
      return { success: false, error: "Item not found" };
    }
  }

  for (const map of mappings) {
    if (map.action === "ignore") continue;

    let finalItemId = map.itemId;

    if (map.action === "create") {
      // readableId and name are whatever the user typed in the create field,
      // falling back to the extracted description.
      const createName = (map.createName || map.description || "").trim();
      if (!createName) continue;

      // Reuse an existing item with the same readableId instead of failing on
      // the unique constraint / creating a duplicate.
      const existing = await serviceRole
        .from("item")
        .select("id")
        .eq("companyId", companyId)
        .eq("readableId", createName)
        .maybeSingle();

      if (existing.data) {
        finalItemId = existing.data.id;
      } else {
        // Create through the standard Part flow (item + part + companion rows)
        // with the service role, since the invoicing-scoped client can't insert
        // items under RLS. Purchased items default to Buy.
        const created = await upsertPart(serviceRole, {
          id: createName,
          name: createName,
          revision: "0",
          description: map.description || undefined,
          replenishmentSystem: "Buy",
          defaultMethodType: "Pull from Inventory",
          itemTrackingType: "Inventory",
          unitOfMeasureCode: "EA",
          shelfLifeCalculateFromBom: false,
          companyId,
          createdBy: userId
        });

        if (!created.error && created.data?.id) {
          finalItemId = created.data.id;
        }
      }
    }

    if (finalItemId) {
      // Set the line's item and promote it from a Comment to a Part line.
      await client
        .from("purchaseInvoiceLine")
        .update({
          itemId: finalItemId,
          invoiceLineType: "Part",
          updatedBy: userId
        })
        .eq("id", map.lineId);
    }
  }

  return { success: true };
>>>>>>> 0608ffdc42d0089409e81ee6e8dee290416e4822
}
