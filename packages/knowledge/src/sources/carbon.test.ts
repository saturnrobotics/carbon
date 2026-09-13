import { describe, expect, it } from "vitest";
import {
  CARBON_PRICING_CAPABILITY,
  carbonSearchTerm,
  createCarbonChangeFeed,
  createCarbonSourceAdapter,
  nextSweepState,
  planCarbonChanges,
  projectCarbonItem
} from "./carbon.server";
import { SOURCE_READ_DEADLINE_MS } from "./http.server";
import { factValidUntil } from "./outcome";

const connection = { origin: "https://erp.example", audience: "erp-audience" };
const identity = {
  principal: {
    kind: "human" as const,
    actorId: "alice",
    companyId: "company-a",
    callerId: "query",
    sourceIdentity: { issuer: "iap", subject: "a" },
    policyVersion: "identity-1:permission-1",
    capabilities: ["knowledge.read"]
  },
  companyGroupId: "group-a",
  allowedOperations: [],
  accessLevels: [],
  assurance: { mode: "carbon-mfa" as const }
};
const motorA = {
  id: "item-motor-a",
  readableId: "MTR-34-60",
  readableIdWithRevision: "MTR-34-60-B",
  name: "NEMA 34 stepper motor, 6.0 N·m",
  description: null,
  type: "Part",
  revision: "B",
  revisionStatus: "Production",
  mpn: "M-34-60",
  unitOfMeasureCode: "EA",
  active: true,
  updatedAt: "2026-09-01T10:00:00Z",
  // A price is never part of the projection even when the source leaks it.
  unitCost: 1234
};
const motorB = {
  ...motorA,
  id: "item-motor-b",
  readableId: "MTR-34-80",
  mpn: "M-34-80"
};

function adapter(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>
) {
  return createCarbonSourceAdapter(connection, {
    request: new Request("https://query.example"),
    identity,
    headers: async () => new Headers(),
    fetch: async (url, init) => handler(url as URL, init ?? {})
  });
}

describe("Carbon read adapter", () => {
  it("projects a bounded item page with an authenticated deep link and a freshness stamp", async () => {
    const source = adapter((url) => {
      expect(url.pathname).toBe("/api/v1/knowledge/resolveItems");
      return Response.json({ results: [motorA, motorB], count: null });
    });
    const { outcome, page } = await source.searchEntities({
      query: "NEMA 34 motor",
      limit: 10
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(page?.status).toBe("complete");
    expect(page?.items.map((item) => item.id)).toEqual([
      "item-motor-a",
      "item-motor-b"
    ]);
    expect(page?.items[0]?.fields).toMatchObject({
      readableId: "MTR-34-60",
      revision: "B",
      mpn: "M-34-60",
      link: "https://erp.example/x/part/item-motor-a"
    });
    expect(JSON.stringify(page)).not.toContain("unitCost");
    expect(page?.observedAt).toMatch(/Z$/);
  });
  it("marks a full page as partial instead of pretending the bound was the population", async () => {
    const source = adapter(() =>
      Response.json({ results: [motorA, motorB], count: null })
    );
    const { page } = await source.searchEntities({ query: "motor", limit: 2 });
    expect(page).toMatchObject({
      status: "partial",
      incompleteReason: "bounded-result-truncated"
    });
    expect(page?.items).toHaveLength(2);
  });
  it("sanitizes the search to what Carbon's validator admits", () => {
    expect(carbonSearchTerm("NEMA 34; DROP TABLE item -- (60 N·m)")).toBe(
      "NEMA 34 DROP TABLE item -- 60 N m"
    );
    expect(carbonSearchTerm("   ")).toBe("");
  });
  it("distinguishes a denial, an outage and a deadline from an empty result", async () => {
    const denied = adapter(() => new Response("no", { status: 403 }));
    expect(
      (await denied.searchEntities({ query: "motor", limit: 5 })).outcome
    ).toEqual({ kind: "insufficient-permission" });
    const outage = adapter(() => new Response("boom", { status: 503 }));
    expect(
      (await outage.searchEntities({ query: "motor", limit: 5 })).outcome
    ).toEqual({ kind: "unavailable", reason: "source-error" });
    const slow = adapter(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    );
    const started = performance.now();
    const result = await slow.getEntity("item-motor-a");
    expect(result.outcome).toEqual({ kind: "unavailable", reason: "deadline" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      SOURCE_READ_DEADLINE_MS - 50
    );
  });
  it("reports a missing item as not-found and never expands the access scope", async () => {
    const source = adapter((url, init) => {
      const body = JSON.parse(String(init.body)) as { itemId: string };
      expect(url.pathname).toBe("/api/v1/knowledge/getItemIdentity");
      return Response.json(body.itemId === "item-motor-a" ? motorA : null);
    });
    expect((await source.getEntity("missing")).outcome).toEqual({
      kind: "not-found"
    });
    const access = await source.checkAccess([
      "item-motor-a",
      "missing",
      "item-motor-a"
    ]);
    expect(access.result.allowedIds).toEqual(["item-motor-a", "item-motor-a"]);
    expect(access.result.policyVersion).toBe("identity-1:permission-1");
    await expect(
      source.checkAccess(
        Array.from({ length: 41 }, (_, index) => `id-${index}`)
      )
    ).rejects.toThrow("access projection");
  });
  it("answers availability from posted receipt evidence with a 15 second validity", async () => {
    const source = adapter((url) => {
      expect(url.pathname).toBe("/api/v1/knowledge/getRecentReceiptItems");
      return Response.json({
        status: "complete",
        items: [
          {
            id: "receipt-old",
            itemId: "item-motor-a",
            revision: "B",
            manufacturer: "",
            mpn: "M-34-60",
            receivedAt: "2026-08-01T00:00:00Z",
            quantity: "4",
            reversedQuantity: "4",
            posted: true,
            voided: false
          },
          {
            id: "receipt-new",
            itemId: "item-motor-a",
            revision: "B",
            manufacturer: "",
            mpn: "M-34-60",
            receivedAt: "2026-09-01T00:00:00Z",
            quantity: "2",
            reversedQuantity: "0",
            posted: true,
            voided: false
          }
        ]
      });
    });
    const { outcome, facts } = await source.queryFacts({
      entityId: "item-motor-a",
      fact: "availability"
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(facts?.facts).toEqual([
      { label: "Last posted receipt", value: "2026-09-01" },
      { label: "Received quantity", value: "2" },
      { label: "Reversed quantity", value: "0" },
      { label: "Posted receipts considered", value: "2" }
    ]);
    expect(factValidUntil("2026-09-01T00:00:00Z")).toBe(
      "2026-09-01T00:00:15.000Z"
    );
    expect(
      (await source.queryFacts({ entityId: "x", fact: "contact-summary" }))
        .outcome
    ).toEqual({ kind: "unavailable", reason: "unsupported" });
  });
  it("rejects a fact name that is not in the contract", async () => {
    const source = adapter(() => Response.json(null));
    await expect(
      source.queryFacts({ entityId: "x", fact: "SELECT * FROM itemCost" })
    ).rejects.toThrow();
  });
});

describe("Carbon supplier pricing", () => {
  const price = {
    supplierId: "sup-acme",
    supplierUnitPrice: 12.34,
    currencyCode: "USD",
    unitOfMeasureCode: "EA",
    updatedAt: "2026-09-01T10:00:00Z"
  };
  /** The same adapter, for a caller whose binding carries the stated capabilities. */
  function pricingAdapter(
    capabilities: string[],
    handler: (url: URL, init: RequestInit) => Response | Promise<Response>
  ) {
    return createCarbonSourceAdapter(connection, {
      request: new Request("https://query.example"),
      identity: {
        ...identity,
        principal: { ...identity.principal, capabilities }
      },
      headers: async () => new Headers(),
      fetch: async (url, init) => handler(url as URL, init ?? {})
    });
  }

  it("reaches the pricing operation for a caller holding the pricing capability", async () => {
    let seen: unknown;
    const source = pricingAdapter(
      ["knowledge.read", CARBON_PRICING_CAPABILITY],
      (url, init) => {
        expect(url.pathname).toBe("/api/v1/knowledge/getItemSupplierPricing");
        seen = JSON.parse(String(init.body));
        return Response.json({
          results: [price, { ...price, supplierId: "sup-bolt" }],
          count: null
        });
      }
    );
    const result = await source.getSupplierPricing("item-motor-a");
    expect(seen).toEqual({ itemId: "item-motor-a" });
    expect(result.outcome).toEqual({ kind: "ok" });
    expect(result.status).toBe("complete");
    expect(result.prices).toEqual([
      price,
      { ...price, supplierId: "sup-bolt" }
    ]);
    expect(result.validUntil).toBe(factValidUntil(result.observedAt));
  });

  it("passes the supplier filter through and projects only the agreed fields", async () => {
    let seen: unknown;
    const source = pricingAdapter(
      ["knowledge.read", CARBON_PRICING_CAPABILITY],
      (_url, init) => {
        seen = JSON.parse(String(init.body));
        // A leaked internal cost must not survive the projection.
        return Response.json([{ ...price, itemCost: 9.99 }]);
      }
    );
    const result = await source.getSupplierPricing("item-motor-a", "sup-acme");
    expect(seen).toEqual({ itemId: "item-motor-a", supplierId: "sup-acme" });
    expect(result.prices).toEqual([price]);
    expect(JSON.stringify(result)).not.toContain("itemCost");
  });

  it("refuses a caller without the pricing capability before any request is made", async () => {
    let called = false;
    const source = pricingAdapter(["knowledge.read"], () => {
      called = true;
      return Response.json([price]);
    });
    const result = await source.getSupplierPricing("item-motor-a");
    expect(result.outcome).toEqual({ kind: "insufficient-permission" });
    expect(result.prices).toBeNull();
    expect(called).toBe(false);
  });

  it("refuses a caller holding neither the capability nor the transport read", async () => {
    let called = false;
    const source = pricingAdapter([], () => {
      called = true;
      return Response.json([price]);
    });
    expect((await source.getSupplierPricing("item-motor-a")).outcome).toEqual({
      kind: "insufficient-permission"
    });
    expect(called).toBe(false);
  });

  it("maps Carbon's own denial to insufficient-permission, not an empty price list", async () => {
    // The capability alone is not the grant: Carbon still gates on purchasing
    // view, and that refusal must never read as "this item has no prices".
    const denied = pricingAdapter(
      ["knowledge.read", CARBON_PRICING_CAPABILITY],
      () => new Response("no", { status: 403 })
    );
    const result = await denied.getSupplierPricing("item-motor-a");
    expect(result.outcome).toEqual({ kind: "insufficient-permission" });
    expect(result.prices).toBeNull();
    const outage = pricingAdapter(
      ["knowledge.read", CARBON_PRICING_CAPABILITY],
      () => new Response("boom", { status: 503 })
    );
    expect((await outage.getSupplierPricing("item-motor-a")).outcome).toEqual({
      kind: "unavailable",
      reason: "source-error"
    });
  });

  it("marks a full page partial rather than passing the bound off as the population", async () => {
    const source = pricingAdapter(
      ["knowledge.read", CARBON_PRICING_CAPABILITY],
      () =>
        Response.json(
          Array.from({ length: 50 }, (_unused, index) => ({
            ...price,
            supplierId: `sup-${index}`
          }))
        )
    );
    const result = await source.getSupplierPricing("item-motor-a");
    expect(result.status).toBe("partial");
    expect(result.prices).toHaveLength(50);
  });

  it("refuses an identifier Carbon's validator would not admit", async () => {
    const source = pricingAdapter(
      ["knowledge.read", CARBON_PRICING_CAPABILITY],
      () => Response.json([])
    );
    await expect(
      source.getSupplierPricing("item-motor-a; DROP TABLE item")
    ).rejects.toThrow("entity identifier");
    await expect(
      source.getSupplierPricing("item-motor-a", "sup acme")
    ).rejects.toThrow("entity identifier");
  });
});

describe("Carbon change feed", () => {
  const machine = {
    companyId: "company-a",
    authorizationHeader: async () => "Bearer fresh-service-token"
  };
  it("claims through the source-changes route with machine headers only", async () => {
    let seen: { url: URL; init: RequestInit } | undefined;
    const feed = createCarbonChangeFeed(
      connection,
      {
        ...machine,
        fetch: async (url, init) => {
          seen = { url: url as URL, init: init ?? {} };
          return Response.json({
            items: [
              {
                id: "kso-1",
                entityType: "item",
                entityId: "item-motor-a",
                sourceVersion: "2026-09-01T10:00:00.000000Z",
                eventType: "upsert",
                observedAt: "2026-09-01T10:00:05Z",
                entity: projectCarbonItem(motorA, "2026-09-01T10:00:00.000000Z")
              }
            ],
            observedAt: "2026-09-01T10:00:05Z",
            sourceRevision: "carbon:company-a:2026-09-01T10:00:05Z",
            status: "complete",
            leaseExpiresAt: "2026-09-01T10:05:05+00:00"
          });
        }
      },
      { sourceId: "source-carbon", workerId: "worker-1" }
    );
    const page = await feed.getChanges({ limit: 500 });
    expect(seen?.url.pathname).toBe("/api/v1/knowledge/source-changes");
    const headers = new Headers(seen?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer fresh-service-token");
    expect(headers.get("x-portal-company-id")).toBe("company-a");
    expect(headers.has("x-portal-user-evidence")).toBe(false);
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      sourceId: "source-carbon",
      action: "claim",
      workerId: "worker-1",
      limit: 100
    });
    expect(page.items[0]?.entity?.fields.link).toBe(
      "https://erp.example/x/part/item-motor-a"
    );
    expect(page.leaseExpiresAt).toBe("2026-09-01T10:05:05+00:00");
  });
  it("refuses an over-long acknowledgement batch", async () => {
    const feed = createCarbonChangeFeed(
      connection,
      { ...machine, fetch: async () => Response.json({ acknowledged: [] }) },
      { sourceId: "source-carbon", workerId: "worker-1" }
    );
    await expect(
      feed.acknowledge(Array.from({ length: 101 }, (_, index) => `e-${index}`))
    ).rejects.toThrow("too large");
    expect(await feed.acknowledge([])).toEqual([]);
  });
});

describe("Carbon projection planning", () => {
  const observedAt = "2026-09-01T10:00:05Z";
  const upsert = (id: string, at = observedAt) => ({
    id: `kso-${id}-${at}`,
    entityType: "item",
    entityId: id,
    sourceVersion: at,
    eventType: "upsert" as const,
    observedAt: at,
    entity: projectCarbonItem({ ...motorA, id }, at)
  });
  it("collapses duplicates, keeps the newest observation and lets a later upsert cancel a tombstone", () => {
    const plan = planCarbonChanges([
      { ...upsert("item-1"), entity: null },
      upsert("item-1", "2026-09-01T10:00:09Z"),
      upsert("item-1", "2026-09-01T10:00:01Z"),
      upsert("item-1", "2026-09-01T10:00:09Z")
    ]);
    expect(plan.tombstones).toEqual([]);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      sourceEntityId: "item-1",
      entityType: "part",
      observedAt: "2026-09-01T10:00:09Z",
      exactIdentifiers: {
        readableId: "MTR-34-60",
        mpn: "M-34-60",
        revision: "B"
      }
    });
  });
  it("lands a receipt line on its receipt and records tombstones and ACL changes for the outbox", () => {
    const plan = planCarbonChanges([
      {
        id: "kso-line",
        entityType: "receiptLine",
        entityId: "line-1",
        sourceVersion: "v1",
        eventType: "delete",
        observedAt,
        target: { entityType: "receipt", entityId: "receipt-1" },
        entity: null
      },
      {
        id: "kso-acl",
        entityType: "item",
        entityId: "item-2",
        sourceVersion: "v2",
        eventType: "acl-change",
        observedAt,
        entity: projectCarbonItem({ ...motorA, id: "item-2" }, "v2")
      }
    ]);
    expect(plan.tombstones).toEqual([
      {
        sourceEntityId: "receipt-1",
        entityType: "receipt",
        sourceVersion: "v1",
        observedAt
      }
    ]);
    expect(plan.aclChanges).toEqual([
      { sourceEntityId: "item-2", entityType: "part", sourceVersion: "v2" }
    ]);
    expect(plan.upserts.map((row) => row.sourceEntityId)).toEqual(["item-2"]);
  });
  it("walks entity types in order and wraps around", () => {
    expect(
      nextSweepState(
        { entityType: "item", afterId: null },
        { lastId: "i-9", done: false }
      )
    ).toEqual({ entityType: "item", afterId: "i-9" });
    expect(
      nextSweepState(
        { entityType: "item", afterId: "i-9" },
        { lastId: null, done: true }
      )
    ).toEqual({ entityType: "receipt", afterId: null });
    expect(
      nextSweepState(
        { entityType: "purchaseOrder", afterId: "p" },
        { lastId: "q", done: true }
      )
    ).toEqual({ entityType: "item", afterId: null });
  });
});
