import type { Principal } from "@carbon/knowledge";
import {
  GoogleWorkforceTokenVerifier,
  type TrustedTokenVerifier
} from "@carbon/knowledge/identity.server";

type MachineCapability = Extract<
  Principal,
  { kind: "machine" }
>["capabilities"][number];
export type MachineCallerConfiguration = {
  audience: string;
  callers: Array<{
    subject: string;
    callerId: string;
    companyIds: string[];
    sourceIds: string[];
    capabilities: MachineCapability[];
  }>;
};

function unauthorized(): Error {
  return new Error("unauthorized machine request");
}

export function parseMachineCallerConfiguration(
  value: string | unknown
): MachineCallerConfiguration {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw unauthorized();
  const config = parsed as Record<string, unknown>;
  if (
    typeof config.audience !== "string" ||
    !config.audience ||
    !Array.isArray(config.callers) ||
    !config.callers.length ||
    config.callers.length > 64
  )
    throw unauthorized();
  const callers = config.callers.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw unauthorized();
    const caller = raw as Record<string, unknown>;
    const arrays = [caller.companyIds, caller.sourceIds, caller.capabilities];
    if (
      typeof caller.subject !== "string" ||
      !caller.subject ||
      caller.subject.length > 512 ||
      typeof caller.callerId !== "string" ||
      !caller.callerId ||
      caller.callerId.length > 128 ||
      arrays.some(
        (entry) =>
          !Array.isArray(entry) ||
          !entry.length ||
          entry.length > 64 ||
          entry.some(
            (value) => typeof value !== "string" || !value || value.length > 512
          )
      )
    )
      throw unauthorized();
    const capabilities = caller.capabilities as string[];
    if (
      capabilities.some(
        (capability) =>
          capability !== "source.changes.read" &&
          capability !== "source.index.read"
      )
    )
      throw unauthorized();
    return {
      subject: caller.subject,
      callerId: caller.callerId,
      companyIds: caller.companyIds as string[],
      sourceIds: caller.sourceIds as string[],
      capabilities: capabilities as MachineCapability[]
    };
  });
  return { audience: config.audience, callers };
}

export async function verifyMachineRequest(options: {
  request: Request;
  sourceId: string;
  capability: MachineCapability;
  configuration: MachineCallerConfiguration;
  tokenVerifier?: Pick<TrustedTokenVerifier, "verifyServiceToken">;
  nowEpochSeconds?: number;
}): Promise<Extract<Principal, { kind: "machine" }>> {
  try {
    if (
      options.request.headers.has("x-portal-user-evidence") ||
      options.request.headers.has("x-goog-iap-jwt-assertion")
    )
      throw unauthorized();
    const authorization = options.request.headers.get("authorization");
    const companyId = options.request.headers
      .get("x-portal-company-id")
      ?.trim();
    if (
      !authorization?.startsWith("Bearer ") ||
      !companyId ||
      !options.sourceId
    )
      throw unauthorized();
    const claims = await (
      options.tokenVerifier ?? new GoogleWorkforceTokenVerifier()
    ).verifyServiceToken(
      authorization.slice(7).trim(),
      options.configuration.audience
    );
    const now =
      options.nowEpochSeconds ??
      Math.floor((performance.timeOrigin + performance.now()) / 1_000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      !claims.sub ||
      !claims.iat ||
      !claims.exp ||
      claims.exp < now - 30 ||
      claims.iat > now + 30 ||
      claims.exp <= claims.iat ||
      !audience.includes(options.configuration.audience) ||
      (claims.iss !== "accounts.google.com" &&
        claims.iss !== "https://accounts.google.com")
    )
      throw unauthorized();
    const caller = options.configuration.callers.find(
      (entry) =>
        entry.subject === claims.sub &&
        entry.companyIds.includes(companyId) &&
        entry.sourceIds.includes(options.sourceId) &&
        entry.capabilities.includes(options.capability)
    );
    if (!caller) throw unauthorized();
    return {
      kind: "machine",
      callerId: caller.callerId,
      companyId,
      sourceIds: [options.sourceId],
      policyVersion: `machine:${caller.callerId}`,
      capabilities: [options.capability]
    };
  } catch {
    throw unauthorized();
  }
}
