import { assertIsPost } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { trigger } from "@carbon/jobs";
import { InvoiceRecognitionError } from "@carbon/jobs/invoice-intake";
import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import { invoiceIntakeActionValidator } from "~/modules/invoicing/invoicing.models";
import {
  approveInvoiceIntake,
  getInvoiceIntakeReview,
  InvoiceIntakeError,
  saveInvoiceIntakeReview,
  setInvoiceIntakeStatus,
  updateInvoiceRecognitionRule
} from "~/modules/invoicing/invoicing.server";
import { assertMercuryRequestOrigin } from "~/modules/invoicing/mercury.server";
import { getDatabaseClient } from "~/services/database.server";

export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  assertMercuryRequestOrigin(request);
  const actor = await requirePermissions(request, { view: "invoicing" });
  const id = params.intakeId;
  if (!id) return data({ error: "Document not found" }, { status: 404 });
  const db = getDatabaseClient();
  try {
    const body: unknown = await request.json();
    const rule = z
      .object({
        action: z.literal("rule"),
        id: z.string().min(1),
        operation: z.enum(["disable", "replace"]),
        expectedVersion: z.number().int().positive(),
        supplierId: z.string().optional(),
        reason: z.string().max(1000).optional()
      })
      .safeParse(body);
    if (rule.success) {
      await getInvoiceIntakeReview(db, actor, id);
      await updateInvoiceRecognitionRule(db, actor, {
        ...rule.data,
        action: rule.data.operation
      });
      return data({ success: true });
    }
    const suggestion = z
      .object({
        action: z.literal("suggest"),
        expectedRevision: z.number().int().nonnegative()
      })
      .safeParse(body);
    if (suggestion.success) {
      await requirePermissions(request, { update: "invoicing" });
      const current = await getInvoiceIntakeReview(db, actor, id);
      if (current.intake.revision !== suggestion.data.expectedRevision)
        return data(
          {
            error:
              "The document changed. Refresh and review the latest version."
          },
          { status: 409 }
        );
      await trigger("invoice-intake-match", {
        companyId: actor.companyId,
        intakeId: id,
        generation: current.intake.generation,
        revision: current.intake.revision
      });
      return data({ success: true });
    }
    const parsed = invoiceIntakeActionValidator.safeParse(body);
    if (!parsed.success)
      return data(
        {
          error: "Review contains invalid values",
          issues: parsed.error.issues
        },
        { status: 400 }
      );
    const input = parsed.data;
    if (input.action === "save") {
      if (!input.review)
        return data({ error: "Review is required" }, { status: 400 });
      const result = await saveInvoiceIntakeReview(db, actor, {
        id,
        expectedRevision: input.expectedRevision,
        review: input.review
      });
      return data({ success: true, result });
    }
    if (input.action === "approve" || input.action === "link") {
      if (!input.approvalKey)
        return data(
          { error: "Approval identity is required" },
          { status: 400 }
        );
      const result = await approveInvoiceIntake(db, actor, {
        intakeId: id,
        expectedRevision: input.expectedRevision,
        approvalKey: input.approvalKey,
        decisions: input.review
      });
      return data({ success: true, result });
    }
    const result = await setInvoiceIntakeStatus(db, actor, {
      id,
      expectedRevision: input.expectedRevision,
      action: input.action
    });
    return data({ success: true, result });
  } catch (error) {
    // Domain refusal messages contain operator instructions; database internals stay server-side.
    const message =
      error instanceof InvoiceIntakeError ||
      error instanceof InvoiceRecognitionError
        ? error.message
        : "The operation could not be completed. Refresh and retry.";
    return data({ error: message }, { status: 409 });
  }
}
