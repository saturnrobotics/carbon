import { assertIsPost } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { INVOICE_LIMITS, trigger } from "@carbon/jobs";
import {
  InvoiceSourceError,
  registerInvoiceSource
} from "@carbon/jobs/invoice-intake";
import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { assertMercuryRequestOrigin } from "~/modules/invoicing/mercury.server";
import { getDatabaseClient } from "~/services/database.server";

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  assertMercuryRequestOrigin(request);
  const { companyId, userId } = await requirePermissions(request, {
    view: "invoicing"
  });
  // Bound multipart framing as well as the extracted file; do not buffer an unbounded request.
  const reader = request.body?.getReader();
  if (!reader) return data({ error: "Choose a PDF or image" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    byteSize += next.value.byteLength;
    if (byteSize > INVOICE_LIMITS.pdfBytes + 1024 * 1024) {
      await reader.cancel();
      return data(
        { error: "Document is too large; split it into smaller files" },
        { status: 413 }
      );
    }
    chunks.push(next.value);
  }
  try {
    const bytes = new Uint8Array(byteSize);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const form = await new Response(bytes, {
      headers: { "content-type": request.headers.get("content-type") ?? "" }
    }).formData();
    const file = form.get("file");
    if (!(file instanceof File))
      return data({ error: "Choose a PDF or image" }, { status: 400 });
    const result = await registerInvoiceSource(
      getDatabaseClient(),
      getCarbonServiceRole().storage,
      { companyId, userId },
      {
        kind: "upload",
        sourceKey: String(form.get("sourceKey") ?? crypto.randomUUID()),
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        existingIntakeId: String(form.get("intakeId") ?? "") || undefined,
        purchaseInvoiceId:
          String(form.get("purchaseInvoiceId") ?? "") || undefined,
        historical: form.get("historical") === "true"
      }
    );
    if (result.needsDispatch) {
      try {
        await trigger("invoice-intake", {
          companyId,
          intakeId: result.intakeId,
          generation: result.generation
        });
      } catch {
        /* Committed queue state is recovered by the scheduled reconciler. */
      }
    }
    return data({ intakeId: result.intakeId, existing: result.existing });
  } catch (error) {
    return data(
      {
        error:
          error instanceof InvoiceSourceError
            ? error.message
            : "Unable to register the document. Check its format and retry."
      },
      { status: 400 }
    );
  }
}
