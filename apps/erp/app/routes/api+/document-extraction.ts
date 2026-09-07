import { assertIsPost, error } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { flash } from "@carbon/auth/session.server";
import { trigger } from "@carbon/jobs";
import {
  registerInvoiceSource,
  validateInvoiceSourceBytes
} from "@carbon/jobs/invoice-intake";
import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { insertDocumentExtraction } from "~/modules/documents/documents.service";
import { assertMercuryRequestOrigin } from "~/modules/invoicing/mercury.server";
import { getDatabaseClient } from "~/services/database.server";

// Each document type must be gated by the permission for the module that owns it,
// and paired with the source document the client claims to be extracting.
const DOCUMENT_TYPES = {
  salesRfq: { module: "sales", sourceDocument: "Request for Quote" },
  purchaseInvoice: { module: "invoicing", sourceDocument: "Purchase Invoice" }
} as const;

type DocumentType = keyof typeof DOCUMENT_TYPES;

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  assertMercuryRequestOrigin(request);

  const formData = await request.formData();
  const storagePath = formData.get("storagePath") as string;
  const documentType = formData.get("documentType") as DocumentType;
  const sourceDocument = formData.get("sourceDocument") as string;
  const sourceDocumentId =
    (formData.get("sourceDocumentId") as string) || undefined;

  if (!storagePath || !documentType || !sourceDocument) {
    return data({ error: "Missing required fields" }, { status: 400 });
  }

  const documentConfig = DOCUMENT_TYPES[documentType];
  if (!documentConfig || documentConfig.sourceDocument !== sourceDocument) {
    return data({ error: "Invalid document type" }, { status: 400 });
  }

  // Gate on the module that owns this document type — an RFQ is a sales document,
  // an invoice is a purchasing document.
  const { client, companyId, userId } = await requirePermissions(request, {
    view: documentConfig.module
  });

  if (
    !storagePath.startsWith(`${companyId}/extractions/`) ||
    storagePath
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    Array.from(storagePath).some(
      (character) => character === "\\" || character.charCodeAt(0) < 32
    )
  ) {
    return data({ error: "Invalid source path" }, { status: 400 });
  }
  // Read through the authenticated client before a privileged extraction registration.
  const source = await client.storage.from("private").download(storagePath);
  if (source.error || !source.data)
    return data({ error: "Source document is unavailable" }, { status: 403 });
  if (source.data.size > 10 * 1024 * 1024)
    return data(
      { error: "Split this document into smaller files" },
      { status: 413 }
    );
  const bytes = new Uint8Array(await source.data.arrayBuffer());
  try {
    validateInvoiceSourceBytes(bytes);
  } catch {
    return data({ error: "Invalid PDF or image" }, { status: 400 });
  }
  if (documentType === "purchaseInvoice") {
    const registered = await registerInvoiceSource(
      getDatabaseClient(),
      getCarbonServiceRole().storage,
      { companyId, userId },
      {
        kind: "upload",
        sourceKey: `legacy:${storagePath}`,
        bytes,
        fileName: storagePath.split("/").at(-1),
        purchaseInvoiceId: sourceDocumentId
      }
    );
    if (registered.needsDispatch) {
      try {
        await trigger("invoice-intake", {
          companyId,
          intakeId: registered.intakeId,
          generation: registered.generation
        });
      } catch {
        /* The persisted queue is recovered by reconciliation. */
      }
    }
    return data({ intakeId: registered.intakeId });
  }
  const result = await insertDocumentExtraction(getDatabaseClient(), {
    storagePath,
    documentType,
    sourceDocument,
    sourceDocumentId,
    companyId,
    createdBy: userId
  });

  if (result.error) {
    return data(
      {},
      await flash(request, error(result.error, "Failed to start extraction"))
    );
  }

  return data({ extractionId: result.data?.id });
}
