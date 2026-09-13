import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyWorkforceRequest: vi.fn(),
  getUserScopedClient: vi.fn(),
  getFreshUserClaims: vi.fn(),
  userHasVerifiedTotpFactor: vi.fn(),
  environment: { controlled: false }
}));

vi.mock("@carbon/portal/identity.server", () => ({
  verifyWorkforceRequest: mocks.verifyWorkforceRequest
}));
vi.mock("@carbon/env", () => ({
  get CONTROLLED_ENVIRONMENT() {
    return mocks.environment.controlled;
  }
}));
vi.mock("../lib/supabase/client.server", () => ({
  getUserScopedClient: mocks.getUserScopedClient
}));
vi.mock("./users.server", () => ({
  getFreshUserClaims: mocks.getFreshUserClaims
}));
vi.mock("./mfa.server", () => ({
  userHasVerifiedTotpFactor: mocks.userHasVerifiedTotpFactor
}));

const identity = {
  principal: {
    kind: "human",
    actorId: "usr_existing",
    companyId: "cmp_alpha",
    callerId: "portal-query",
    sourceIdentity: { issuer: "iap", subject: "immutable-subject" },
    policyVersion: "identity-3:permissions-5",
    capabilities: ["source.entity.read"]
  },
  companyGroupId: "grp_alpha",
  allowedOperations: ["portal_getItemIdentity"],
  accessLevels: ["managed-device"],
  assurance: { mode: "carbon-mfa" }
};
const claims = {
  role: "employee",
  permissions: {
    parts: { view: ["cmp_alpha"], create: [], update: [], delete: [] }
  }
};

/** A user-scoped client whose only supported read is the company's MFA setting. */
function clientWithSettings(
  result: { data: { requireMfa: boolean } | null; error: unknown } = {
    data: { requireMfa: false },
    error: null
  }
) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from }, from, select, eq };
}

async function authorize(options: {
  assurance?:
    | { mode: "carbon-mfa" }
    | { mode: "workspace-equivalent"; accessLevel: string };
  settings?: Parameters<typeof clientWithSettings>[0];
  factorEnrolled?: boolean;
}) {
  const settings = clientWithSettings(options.settings);
  mocks.verifyWorkforceRequest.mockResolvedValue({
    ...identity,
    assurance: options.assurance ?? identity.assurance
  });
  mocks.getUserScopedClient.mockResolvedValue(settings.client);
  mocks.getFreshUserClaims.mockResolvedValue(claims);
  mocks.userHasVerifiedTotpFactor.mockResolvedValue(
    options.factorEnrolled ?? false
  );
  const { authorizeWorkforceRequest } = await import("./workforce.server");
  const result = await authorizeWorkforceRequest({
    request: new Request("https://api.example.com"),
    operation: "portal_getItemIdentity",
    configuration: {} as never,
    identityStore: {} as never
  });
  return { result, settings };
}

describe("authorizeWorkforceRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.environment.controlled = false;
  });

  it("uses the canonical actor for a user-scoped client and current permissions", async () => {
    const { result, settings } = await authorize({});

    expect(mocks.getUserScopedClient).toHaveBeenCalledWith("usr_existing");
    expect(mocks.getFreshUserClaims).toHaveBeenCalledWith(
      "usr_existing",
      "cmp_alpha"
    );
    expect(result).toMatchObject({ client: settings.client, ...claims });
    expect(result.principal).toEqual({
      ...identity.principal,
      assurance: { required: false, satisfied: true, method: "carbon-mfa" }
    });
    expect(settings.from).toHaveBeenCalledWith("companySettings");
    expect(settings.select).toHaveBeenCalledWith("requireMfa");
    expect(settings.eq).toHaveBeenCalledWith("id", "cmp_alpha");
  });

  it("does not consult factor state when the company does not require MFA", async () => {
    await authorize({ settings: { data: null, error: null } });
    expect(mocks.userHasVerifiedTotpFactor).not.toHaveBeenCalled();
  });

  it("leaves carbon-mfa unsatisfied for a required company when the actor has no factor", async () => {
    const { result } = await authorize({
      settings: { data: { requireMfa: true }, error: null },
      factorEnrolled: false
    });
    expect(mocks.userHasVerifiedTotpFactor).toHaveBeenCalledWith(
      "usr_existing"
    );
    expect(result.principal.assurance).toEqual({
      required: true,
      satisfied: false,
      method: "carbon-mfa"
    });
  });

  it("leaves carbon-mfa unsatisfied even for an enrolled actor: the forwarding contract carries no Carbon session", async () => {
    const { result } = await authorize({
      settings: { data: { requireMfa: true }, error: null },
      factorEnrolled: true
    });
    expect(result.principal.assurance).toEqual({
      required: true,
      satisfied: false,
      method: "carbon-mfa"
    });
  });

  it("satisfies a required company through the documented workspace equivalence", async () => {
    const { result } = await authorize({
      assurance: { mode: "workspace-equivalent", accessLevel: "level" },
      settings: { data: { requireMfa: true }, error: null }
    });
    expect(result.principal.assurance).toEqual({
      required: true,
      satisfied: true,
      method: "workspace-equivalent"
    });
    expect(mocks.userHasVerifiedTotpFactor).not.toHaveBeenCalled();
  });

  it("treats a controlled deployment as requiring MFA regardless of the company toggle", async () => {
    mocks.environment.controlled = true;
    const { result, settings } = await authorize({
      settings: { data: { requireMfa: false }, error: null }
    });
    expect(settings.from).not.toHaveBeenCalled();
    expect(result.principal.assurance).toEqual({
      required: true,
      satisfied: false,
      method: "carbon-mfa"
    });
  });

  it("fails closed when the company's MFA requirement cannot be read", async () => {
    await expect(
      authorize({ settings: { data: null, error: new Error("read failed") } })
    ).rejects.toThrow(/MFA requirement/);
  });

  it("does not mint a client when identity verification fails", async () => {
    mocks.verifyWorkforceRequest.mockRejectedValue(new Error("unauthorized"));
    const { authorizeWorkforceRequest } = await import("./workforce.server");

    await expect(
      authorizeWorkforceRequest({
        request: new Request("https://api.example.com"),
        operation: "portal_getItemIdentity",
        configuration: {} as never,
        identityStore: {} as never
      })
    ).rejects.toThrow("unauthorized");
    expect(mocks.getUserScopedClient).not.toHaveBeenCalled();
  });

  it("never touches a Carbon session, so no path can stamp mfaVerified", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "workforce.server.ts"),
      "utf8"
    );
    for (const forbidden of [
      "mfaVerified",
      "makeAuthSession",
      "commitAuthSession",
      "setSession",
      "session.server"
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
