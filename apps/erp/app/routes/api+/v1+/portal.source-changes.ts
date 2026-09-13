// Carbon API v1 — the machine-only portal source-changes feed.
//
//   POST /api/v1/portal/source-changes
//
// The portal worker leases, acknowledges and reconciles Carbon's
// `portalSourceOutbox` through this route and never through a database
// connection. It is deliberately not an operation of the `$.ts` dispatch: that
// surface authenticates employees (API keys and workforce evidence), and a
// source indexer is neither. Admission here is the registered-machine contract
// shared with the portal worker's own ingress — a Google service ID token for
// this receiver's audience, an explicit company and source grant, and a refusal
// of any forwarded employee evidence.

import {
  parseMachineCallerConfiguration,
  verifyMachineRequest
} from "@carbon/portal/machine-identity.server";
import type { ActionFunctionArgs } from "react-router";
import {
  acknowledgePortalSourceChanges,
  claimPortalSourceChanges,
  getPortalSourceEntityProjections,
  isActiveCarbonPortalSource,
  listPortalSourceEntityVersions,
  sourceChangesRequestValidator
} from "~/modules/portal/portal.changes.server";
import { getDatabaseClient } from "~/services/database.server";

const NO_STORE = { "cache-control": "no-store" } as const;

function respond(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST")
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" }
    });
  const configurationJson = process.env.PORTAL_MACHINE_CALLERS_JSON?.trim();
  if (!configurationJson)
    return respond(503, { error: "source_changes_not_configured" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(422, { error: "invalid_request" });
  }
  const parsed = sourceChangesRequestValidator.safeParse(body);
  if (!parsed.success) return respond(422, { error: "invalid_request" });
  const input = parsed.data;

  let principal: Awaited<ReturnType<typeof verifyMachineRequest>>;
  try {
    principal = await verifyMachineRequest({
      request,
      sourceId: input.sourceId,
      capability: "source.changes.read",
      configuration: parseMachineCallerConfiguration(configurationJson)
    });
  } catch {
    return respond(401, { error: "unauthorized" });
  }

  const db = getDatabaseClient();
  const companyId = principal.companyId;
  if (!(await isActiveCarbonPortalSource(db, companyId, input.sourceId)))
    return respond(404, { error: "source_not_found" });

  switch (input.action) {
    case "claim":
      return respond(
        200,
        await claimPortalSourceChanges(db, {
          companyId,
          workerId: input.workerId,
          limit: input.limit
        })
      );
    case "acknowledge":
      return respond(
        200,
        await acknowledgePortalSourceChanges(db, {
          companyId,
          workerId: input.workerId,
          eventIds: input.eventIds
        })
      );
    case "versions":
      return respond(
        200,
        await listPortalSourceEntityVersions(db, {
          companyId,
          entityType: input.entityType,
          cursor: input.cursor,
          limit: input.limit
        })
      );
    case "projections":
      return respond(
        200,
        await getPortalSourceEntityProjections(db, {
          companyId,
          entityType: input.entityType,
          entityIds: input.entityIds
        })
      );
  }
}

export function loader() {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" }
  });
}
