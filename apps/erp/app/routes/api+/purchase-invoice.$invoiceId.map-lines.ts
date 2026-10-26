<<<<<<< HEAD
import { assertIsPost } from "@carbon/auth";
||||||| 85d9006e1
=======
// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { carbon } from "@carbon/api/carbon.server";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
import { requirePermissions } from "@carbon/auth/auth.server";
<<<<<<< HEAD
||||||| 85d9006e1
import { getCarbonServiceRole } from "@carbon/auth/client.server";
=======
import { validator } from "@carbon/form";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
<<<<<<< HEAD
import { data } from "react-router";
import { assertMercuryRequestOrigin } from "~/modules/invoicing/mercury.server";
import { getDatabaseClient } from "~/services/database.server";
||||||| 85d9006e1
import { resolveItemIdFromExtractedText, upsertPart } from "~/modules/items";
=======
import { z } from "zod";
import { zfd } from "zod-form-data";
import { mapPurchaseInvoiceLines } from "~/modules/invoicing/invoicing.server";
import { resolveItemIdFromExtractedText } from "~/modules/items/items.service";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75

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
// The form posts the mappings as JSON in one field.
const mappingForm = z.object({
  mappings: zfd.json(mapPurchaseInvoiceLines.input.shape.mappings)
});

export async function action(args: ActionFunctionArgs) {
  const input = await validator(mappingForm).request(args, {
    params: ["invoiceId"]
  });
  if ("invalid" in input) return input.invalid;
  const api = await carbon(args.request);
  const result = await api.invoicing.mapPurchaseInvoiceLines({
    ...input.data,
    invoiceId: input.params.invoiceId
  });
  // The shared mapping modal reads `{ success, error }`, and closes on
  // success: a line that could not be mapped must keep it open.
  if (!result.data) return { success: false, error: result.error?.message };
  if (result.data.failed > 0) {
    return {
      success: false,
      error: "Some lines could not be mapped. Review them and try again."
    };
  }
  return { success: true };
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
}
