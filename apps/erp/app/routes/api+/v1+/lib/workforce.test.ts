import type { ManifestEntry } from "@carbon/api";
import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { AuthedContext } from "./base.server";
import { assertWorkforceAuthorization } from "./base.server";

function context(
  overrides: Partial<NonNullable<AuthedContext["workforce"]>> = {}
): AuthedContext {
  return {
    client: {} as never,
    userId: "usr_existing",
    companyId: "cmp_alpha",
    companyGroupId: "grp_alpha",
    authKind: "workforce",
    scopes: {},
    workforce: {
      allowedOperations: ["portal_getItemIdentity"],
      capabilities: ["portal.read"],
      permissions: {
        parts: {
          view: ["cmp_alpha"],
          create: [],
          update: [],
          delete: []
        }
      },
      policyVersion: "identity-2:permission-4",
      assurance: { required: false, satisfied: true, method: "carbon-mfa" },
      ...overrides
    }
  };
}

function stepUpCode(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof ORPCError
      ? { status: error.status, data: error.data }
      : error;
  }
  return undefined;
}

const itemIdentity = {
  name: "portal_getItemIdentity",
  module: "portal",
  permission: { module: "parts", actions: ["view"] }
} as ManifestEntry;

describe("workforce operation authorization", () => {
  it("requires the exact caller operation, capability, and current permission", () => {
    expect(() =>
      assertWorkforceAuthorization(context(), itemIdentity)
    ).not.toThrow();
  });

  it.each([
    ["operation", { allowedOperations: [] }],
    ["capability", { capabilities: [] }],
    [
      "current permission",
      {
        permissions: {
          parts: { view: [], create: [], update: [], delete: [] }
        }
      }
    ]
  ])("denies missing %s", (_name, override) => {
    expect(() =>
      assertWorkforceAuthorization(context(override), itemIdentity)
    ).toThrow();
  });

  describe("required assurance", () => {
    it("passes when the company requires nothing", () => {
      expect(() =>
        assertWorkforceAuthorization(context(), itemIdentity)
      ).not.toThrow();
    });

    it.each([
      "carbon-mfa",
      "workspace-equivalent"
    ] as const)("passes a satisfied %s requirement", (method) => {
      expect(() =>
        assertWorkforceAuthorization(
          context({ assurance: { required: true, satisfied: true, method } }),
          itemIdentity
        )
      ).not.toThrow();
    });

    it("denies an unsatisfied requirement with the structured step-up code", () => {
      expect(
        stepUpCode(() =>
          assertWorkforceAuthorization(
            context({
              assurance: {
                required: true,
                satisfied: false,
                method: "carbon-mfa"
              }
            }),
            itemIdentity
          )
        )
      ).toEqual({
        status: 403,
        data: { code: "step_up_required", method: "carbon-mfa" }
      });
    });

    it("reports a missing permission before asking for step-up", () => {
      expect(
        stepUpCode(() =>
          assertWorkforceAuthorization(
            context({
              permissions: {
                parts: { view: [], create: [], update: [], delete: [] }
              },
              assurance: {
                required: true,
                satisfied: false,
                method: "carbon-mfa"
              }
            }),
            itemIdentity
          )
        )
      ).toEqual({ status: 403, data: undefined });
    });
  });

  it("denies arbitrary generated operation names", () => {
    expect(() =>
      assertWorkforceAuthorization(context(), {
        ...itemIdentity,
        name: "portal_updateItem"
      })
    ).toThrow();
  });

  it("requires the dedicated procurement capability and purchasing-create permission", () => {
    const procurement = {
      name: "portal_createProcurementDraft",
      module: "portal",
      permission: { module: "purchasing", actions: ["create"] }
    } as ManifestEntry;
    expect(() =>
      assertWorkforceAuthorization(
        context({
          allowedOperations: ["portal_createProcurementDraft"],
          capabilities: ["carbon.procurement.draft"],
          permissions: {
            purchasing: {
              view: [],
              create: ["cmp_alpha"],
              update: [],
              delete: []
            }
          }
        }),
        procurement
      )
    ).not.toThrow();
    expect(() =>
      assertWorkforceAuthorization(
        context({
          allowedOperations: ["portal_createProcurementDraft"],
          capabilities: ["carbon.procurement.draft"],
          permissions: {
            purchasing: { view: [], create: [], update: [], delete: [] }
          }
        }),
        procurement
      )
    ).toThrow();
  });
});
