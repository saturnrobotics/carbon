import { cacheKey } from "@carbon/portal/cache";
import { describe, expect, it } from "vitest";
import { queryCacheScope } from "./cache.server";

const principal = { companyId: "company-a", actorId: "alice", callerId: "web" };
const query = {
  requestId: "r1",
  text: "NEMA-34 motor manual",
  mode: "locate" as const,
  locale: "en"
};
const snapshot = {
  allowed: true,
  policyVersion: "binding:1:1:1",
  epochs: { "source-a:content": "1", "source-a:acl": "1" }
};

describe("query cache scope", () => {
  it("keys every field that changes what an answer contains", () => {
    const base = queryCacheScope({
      principal,
      query,
      sourceIds: ["source-a"],
      businessTimezone: "UTC"
    });
    expect(base.capability).toBe("portal.read");
    expect(base.entities).toEqual(["source-a", ""]);
    expect(base.modelVersion).toBe("locate-no-model");
    expect(base.indexVersion).toBe("lexical-v1");
    const key = cacheKey(base, snapshot);
    const variants = [
      queryCacheScope({
        principal: { ...principal, actorId: "bob" },
        query,
        sourceIds: ["source-a"],
        businessTimezone: "UTC"
      }),
      queryCacheScope({
        principal: { ...principal, companyId: "company-b" },
        query,
        sourceIds: ["source-a"],
        businessTimezone: "UTC"
      }),
      queryCacheScope({
        principal,
        query,
        sourceIds: ["source-b"],
        businessTimezone: "UTC"
      }),
      queryCacheScope({
        principal,
        query: { ...query, context: { entityId: "motor-1" } },
        sourceIds: ["source-a"],
        businessTimezone: "UTC"
      }),
      queryCacheScope({
        principal,
        query: { ...query, mode: "read" },
        sourceIds: ["source-a"],
        businessTimezone: "UTC"
      }),
      queryCacheScope({
        principal,
        query,
        sourceIds: ["source-a"],
        businessTimezone: "America/New_York"
      }),
      queryCacheScope({
        principal,
        query,
        sourceIds: ["source-a"],
        businessTimezone: "UTC",
        embedding: {
          version: "embed-v2",
          project: "synthetic-project",
          location: "synthetic-region",
          model: "synthetic-embedding",
          microUsdPerMillionTokens: 1
        }
      })
    ];
    for (const variant of variants)
      expect(cacheKey(variant, snapshot)).not.toBe(key);
    expect(
      cacheKey(base, {
        ...snapshot,
        epochs: { ...snapshot.epochs, "source-a:acl": "2" }
      })
    ).not.toBe(key);
  });
});
