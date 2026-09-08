import { createHash } from "node:crypto";
import type { Principal } from "@carbon/knowledge";
import { procurementDraftProposalSchema } from "@carbon/knowledge/commands/procurement";

type HumanPrincipal = Extract<Principal, { kind: "human" }>;

function canonicalPayloadHash(value: unknown) {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)])
      );
    }
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export async function executeProcurementDraftCommand({
  command,
  principal,
  sourceUrl,
  forwardHeaders,
  fetchImpl = fetch
}: {
  command: unknown;
  principal: HumanPrincipal;
  sourceUrl: string;
  forwardHeaders: Headers;
  fetchImpl?: typeof fetch;
}): Promise<{
  scheduleId?: string;
  purchaseOrderId?: string;
  replayed: boolean;
}> {
  if (!principal.capabilities.includes("carbon.procurement.draft")) {
    throw new Error("Principal cannot create procurement drafts");
  }
  const proposal = procurementDraftProposalSchema.parse(command);
  if (
    !forwardHeaders.get("authorization") ||
    !forwardHeaders.get("x-portal-user-evidence")
  ) {
    throw new Error("A verified workforce forwarding envelope is required");
  }
  const headers = new Headers(forwardHeaders);
  headers.set("content-type", "application/json");
  const response = await fetchImpl(
    `${sourceUrl.replace(/\/$/, "")}/api/v1/knowledge/createProcurementDraft`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        args: {
          idempotencyKey: proposal.idempotencyKey,
          payloadHash: canonicalPayloadHash({
            supplierId: proposal.supplierId,
            receivingLocationId: proposal.receivingLocationId,
            requestedArrivalDate: proposal.requestedArrivalDate,
            proposedOrderByDate: proposal.proposedOrderByDate,
            executeAt: proposal.executeAt,
            lines: proposal.lines
          }),
          supplierId: proposal.supplierId,
          receivingLocationId: proposal.receivingLocationId,
          requestedArrivalDate: proposal.requestedArrivalDate,
          proposedOrderByDate: proposal.proposedOrderByDate,
          executeAt: proposal.executeAt,
          lines: proposal.lines
        }
      })
    }
  );
  if (!response.ok) {
    throw new Error(
      `Carbon procurement command failed with ${response.status}`
    );
  }
  const result = (await response.json()) as {
    scheduleId?: string;
    purchaseOrderId?: string;
    replayed?: boolean;
  };
  return {
    ...(result.scheduleId ? { scheduleId: result.scheduleId } : {}),
    ...(result.purchaseOrderId
      ? { purchaseOrderId: result.purchaseOrderId }
      : {}),
    replayed: result.replayed === true
  };
}
