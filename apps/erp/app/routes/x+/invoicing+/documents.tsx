import { assertIsPost } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { trigger } from "@carbon/jobs";
import { controlInvoiceIntakeBackfill } from "@carbon/jobs/invoice-intake";
import { msg } from "@lingui/core/macro";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useOutlet } from "react-router";
import { z } from "zod";
import { normalizeInvoiceInboxStatus } from "~/modules/invoicing/invoice-intake.utils";
import { invoiceIntakeSettingsValidator } from "~/modules/invoicing/invoicing.models";
import {
  approveInvoiceIntake,
  getInvoiceIntakeInbox,
  InvoiceIntakeError,
  saveInvoiceIntakeSettings
} from "~/modules/invoicing/invoicing.server";
import { assertMercuryRequestOrigin } from "~/modules/invoicing/mercury.server";
import { InvoiceDocumentInbox } from "~/modules/invoicing/ui/InvoiceDocuments/InvoiceDocumentInbox";
import { getDatabaseClient } from "~/services/database.server";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`Documents`,
  to: path.to.invoiceDocuments,
  module: "invoicing"
};
export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requirePermissions(request, { view: "invoicing" });
  const query = new URL(request.url).searchParams;
  const status = normalizeInvoiceInboxStatus(query.get("status"));
  return {
    ...(await getInvoiceIntakeInbox(getDatabaseClient(), actor, {
      status,
      offset: Number(query.get("offset") ?? 0)
    })),
    status
  };
}
export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  assertMercuryRequestOrigin(request);
  const actor = await requirePermissions(request, { view: "invoicing" });
  const db = getDatabaseClient();
  const input = z
    .discriminatedUnion("action", [
      z.object({
        action: z.literal("settings"),
        settings: invoiceIntakeSettingsValidator
      }),
      z.object({
        action: z.literal("backfill"),
        operation: z.enum(["start", "pause", "resume"])
      }),
      z.object({
        action: z.literal("batch"),
        documents: z
          .array(
            z.object({
              id: z.string().min(1),
              revision: z.number().int().nonnegative(),
              approvalKey: z.string().min(1).max(255)
            })
          )
          .min(1)
          .max(50)
      })
    ])
    .safeParse(await request.json());
  if (!input.success)
    return data({ error: "Invalid document action" }, { status: 400 });
  try {
    if (input.data.action === "settings") {
      await saveInvoiceIntakeSettings(db, actor, input.data.settings);
      return data({ success: true });
    }
    if (input.data.action === "backfill") {
      await controlInvoiceIntakeBackfill(db, actor, input.data.operation);
      if (input.data.operation !== "pause") {
        try {
          await trigger("invoice-intake-backfill", {
            companyId: actor.companyId,
            userId: actor.userId
          });
        } catch {
          /* Persisted backfill is resumed by reconciliation. */
        }
      }
      return data({ success: true });
    }
    const results: { id: string; success: boolean; error?: string }[] = [];
    // Each explicit approval owns its transaction and idempotency key.
    for (const document of input.data.documents) {
      try {
        await approveInvoiceIntake(db, actor, {
          intakeId: document.id,
          expectedRevision: document.revision,
          approvalKey: document.approvalKey
        });
        results.push({ id: document.id, success: true });
      } catch (error) {
        results.push({
          id: document.id,
          success: false,
          error:
            error instanceof InvoiceIntakeError
              ? error.message
              : "Approval failed; open the document to review"
        });
      }
    }
    return data({ success: true, results });
  } catch (error) {
    return data(
      {
        error:
          error instanceof InvoiceIntakeError
            ? error.message
            : "Document settings could not be updated"
      },
      { status: 409 }
    );
  }
}
export default function DocumentsRoute() {
  const result = useLoaderData<typeof loader>();
  const outlet = useOutlet();
  return outlet ?? <InvoiceDocumentInbox data={result} />;
}
