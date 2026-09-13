import { describe, expect, it } from "vitest";
import {
  PORTAL_COMPANY_HEADER,
  PORTAL_USER_EVIDENCE_HEADER,
  type VerifiedWorkforceIdentity
} from "../identity.server";
import {
  runSourceConformance,
  type SourceConformanceFixture
} from "./conformance";
import { entityPageSchema, factQuerySchema, type SourceKind } from "./contract";
import { createCrmExampleProducer } from "./crm.example";
import { createEngineeringExampleProducer } from "./engineering.example";
import {
  createGenericChangeFeed,
  createGenericReadAdapter
} from "./generic.server";
import type { SourceRequestContext } from "./http.server";
import { createSourceRegistry, SOURCE_ADAPTERS } from "./registry.server";

const page = {
  items: [
    {
      id: "part-1",
      type: "pcb",
      title: "Controller",
      revision: "B",
      fields: { status: "released" }
    }
  ],
  observedAt: "2026-09-01T00:00:00Z",
  sourceRevision: "1",
  status: "complete"
};

function identity(
  subject: string,
  companyId: string
): VerifiedWorkforceIdentity {
  return {
    principal: {
      kind: "human",
      actorId: subject,
      companyId,
      callerId: "query",
      sourceIdentity: { issuer: "iap", subject },
      policyVersion: "1",
      capabilities: ["knowledge.read"]
    },
    companyGroupId: companyId,
    allowedOperations: [],
    accessLevels: [],
    assurance: { mode: "carbon-mfa" }
  };
}

/** A reader context whose forwarding headers name the synthetic subject and company. */
function reader(
  fetchImpl: typeof fetch,
  subject: string,
  companyId: string
): SourceRequestContext {
  return {
    request: new Request("https://query.example"),
    identity: identity(subject, companyId),
    headers: async () =>
      new Headers({
        authorization: "Bearer fresh-service-token",
        [PORTAL_USER_EVIDENCE_HEADER]: subject,
        [PORTAL_COMPANY_HEADER]: companyId
      }),
    fetch: fetchImpl
  };
}

type ExampleProducer =
  | ReturnType<typeof createEngineeringExampleProducer>
  | ReturnType<typeof createCrmExampleProducer>;

function fixtureFor(
  sourceId: string,
  kind: SourceKind,
  producer: ExampleProducer,
  throttled?: ExampleProducer
): SourceConformanceFixture {
  const { probes } = producer;
  return {
    source: { id: sourceId, kind, ...producer.connection },
    descriptor: producer.descriptor,
    reader: reader(producer.fetch, probes.subject, probes.companyId),
    outsider: reader(
      producer.fetch,
      probes.outsiderSubject,
      probes.outsiderCompanyId
    ),
    machine: {
      companyId: probes.companyId,
      authorizationHeader: async () => "Bearer machine-service-token",
      fetch: producer.fetch
    },
    probes,
    deleteEntity: (id) => producer.delete(id),
    ...(throttled
      ? { throttled: reader(throttled.fetch, probes.subject, probes.companyId) }
      : {})
  };
}

const clock = () => "2026-09-11T12:00:00Z";

describe("generic source conformance", () => {
  it("accepts a finite engineering projection and rejects accidental private fields", () => {
    expect(entityPageSchema.parse(page).items[0]?.type).toBe("pcb");
    expect(() =>
      entityPageSchema.parse({
        ...page,
        items: [{ ...page.items[0], supplierPrice: 100 }]
      })
    ).toThrow();
  });
  it("rejects unlimited rows and arbitrary fact execution", () => {
    expect(() =>
      entityPageSchema.parse({ ...page, items: Array(101).fill(page.items[0]) })
    ).toThrow();
    expect(() =>
      factQuerySchema.parse({
        entityId: "part-1",
        fact: "SELECT * FROM customer"
      })
    ).toThrow();
  });
  it("does not allow a producer to broaden a requested ACL set", async () => {
    const adapter = createGenericReadAdapter(
      { origin: "https://source.example", audience: "aud" },
      {
        ...reader(async () => new Response(null), "alice", "a"),
        fetch: async () =>
          Response.json({
            allowedIds: ["hidden"],
            policyVersion: "1",
            validUntil: "2026-09-01T00:00:00Z"
          })
      }
    );
    await expect(adapter.checkAccess(["visible"])).rejects.toThrow("expanded");
  });
});

it("registers engineering and CRM producers through the same verified finite transport", async () => {
  const registry = createSourceRegistry(
    {
      version: 1,
      sources: [
        {
          id: "engineering",
          kind: "engineering",
          origin: "https://source.example",
          audience: "aud"
        }
      ]
    },
    { ...reader(async () => Response.json(page), "alice", "a") }
  );
  expect(
    (
      await registry
        .generic("engineering")
        .searchEntities({ query: "controller", limit: 10 })
    ).items[0]?.type
  ).toBe("pcb");
  expect(() => registry.generic("unregistered")).toThrow();
});

describe("declarative adapter registration", () => {
  it("declares every registered kind once, with the contract's schema version", () => {
    for (const kind of ["carbon", "kanban", "engineering", "crm"] as const) {
      const { descriptor } = SOURCE_ADAPTERS[kind];
      expect(descriptor.kind).toBe(kind);
      expect(descriptor.schemaVersion).toBe("source.v1");
      expect(descriptor.auth.human).toBe("workforce-forwarding");
      expect(descriptor.deepLinks.field).toBe("link");
    }
    expect(Object.isFrozen(SOURCE_ADAPTERS)).toBe(true);
  });
  it("describes a registered source from the table, not from a response", () => {
    const engineering = createEngineeringExampleProducer({ clock });
    const registry = createSourceRegistry(
      {
        version: 1,
        sources: [
          { id: "cad", kind: "engineering", ...engineering.connection },
          {
            id: "crm",
            kind: "crm",
            origin: "https://crm.example",
            audience: "crm-audience"
          }
        ]
      },
      reader(engineering.fetch, "engineer-1", "company-a")
    );
    expect(registry.describe("cad")).toEqual(
      SOURCE_ADAPTERS.engineering.descriptor
    );
    expect(registry.describe("crm").entityTypes).toEqual([
      "customer",
      "contact"
    ]);
    expect(() => registry.describe("missing")).toThrow("Source unavailable");
  });
});

describe("synthetic producers pass the conformance suite without router changes", () => {
  it("engineering: versioned machine and PCB designs", async () => {
    const producer = createEngineeringExampleProducer({ clock });
    const throttled = createEngineeringExampleProducer({
      clock,
      rateLimitAfter: 0
    });
    const report = await runSourceConformance(
      fixtureFor("cad", "engineering", producer, throttled)
    );
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.id)).toContain(
      "events.tombstone"
    );
  });
  it("crm: customers with an account-team boundary inside the company", async () => {
    const producer = createCrmExampleProducer({ clock });
    const throttled = createCrmExampleProducer({ clock, rateLimitAfter: 0 });
    const report = await runSourceConformance(
      fixtureFor("crm", "crm", producer, throttled)
    );
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });
  it("fails a producer that widens the requested access scope", async () => {
    const producer = createCrmExampleProducer({ clock });
    const widened: typeof producer = {
      ...producer,
      fetch: async (input, init) => {
        const response = await producer.fetch(input, init);
        const url = input instanceof URL ? input : new URL(String(input));
        if (url.pathname !== "/api/knowledge/access/check" || !response.ok)
          return response;
        const body = (await response.json()) as { allowedIds: string[] };
        return Response.json({
          ...body,
          allowedIds: [...body.allowedIds, "cust-tenant-b-account"]
        });
      }
    };
    const report = await runSourceConformance(
      fixtureFor("crm", "crm", widened)
    );
    expect(report.passed).toBe(false);
    expect(
      report.checks.find((check) => check.id === "access.subset")
    ).toMatchObject({
      passed: false,
      detail: expect.stringContaining("expanded")
    });
  });
});

describe("engineering example: immutable revisions and approval", () => {
  it("releases a draft as a new revision value and keeps the earlier one intact", async () => {
    const producer = createEngineeringExampleProducer({ clock });
    const registry = createSourceRegistry(
      {
        version: 1,
        sources: [{ id: "cad", kind: "engineering", ...producer.connection }]
      },
      reader(producer.fetch, "engineer-1", "company-a")
    );
    const adapter = registry.generic("cad");
    const before = await adapter.getEntity("grinder-frame-mk2");
    expect(before.revision).toBe("grinder-frame-mk2@B");
    expect(before.fields).toMatchObject({
      status: "approved",
      massKg: 418,
      units: "SI"
    });
    // The draft C is never served while it is a draft.
    expect(before.fields.link).toBe(
      "https://engineering.example/designs/grinder-frame-mk2/revisions/B"
    );
    expect(() =>
      producer.release("grinder-frame-mk2", "B", "engineer-4")
    ).toThrow("No such draft revision");
    producer.release("grinder-frame-mk2", "C", "engineer-4");
    const after = await adapter.getEntity("grinder-frame-mk2");
    expect(after.revision).toBe("grinder-frame-mk2@C");
    expect(after.fields).toMatchObject({
      status: "approved",
      approvedAt: clock(),
      approvedBy: "engineer-4",
      massKg: 402
    });
    const feed = createGenericChangeFeed(producer.connection, {
      companyId: "company-a",
      authorizationHeader: async () => "Bearer machine-service-token",
      fetch: producer.fetch
    });
    const events = (await feed.getChanges({ limit: 100 })).items.filter(
      (event) => event.entityId === "grinder-frame-mk2"
    );
    expect(events.map((event) => event.sourceVersion)).toEqual([
      "grinder-frame-mk2@B",
      "grinder-frame-mk2@C"
    ]);
    expect(events[0]?.entity?.fields.massKg).toBe(418);
    // Publishing the same revision again is refused: a revision is a value.
    expect(() =>
      producer.publish({
        companyId: "company-a",
        readers: [],
        entity: after,
        facts: {},
        attachments: [],
        searchTerms: []
      })
    ).toThrow("immutable");
  });
});

describe("crm example: access boundaries", () => {
  it("hides a customer from a reader off its account team, and a tombstone carries no PII", async () => {
    const producer = createCrmExampleProducer({ clock });
    const configuration = {
      version: 1 as const,
      sources: [{ id: "crm", kind: "crm" as const, ...producer.connection }]
    };
    const alice = createSourceRegistry(
      configuration,
      reader(producer.fetch, "alice", "company-a")
    ).generic("crm");
    const bob = createSourceRegistry(
      configuration,
      reader(producer.fetch, "bob", "company-a")
    ).generic("crm");
    await expect(
      alice.getEntity("cust-southern-robotics")
    ).rejects.toMatchObject({
      reason: "denied"
    });
    expect(
      (await bob.getEntity("cust-southern-robotics")).fields.territory
    ).toBe("south");
    const search = await alice.searchEntities({ query: "robotics", limit: 40 });
    expect(search.items).toEqual([]);
    const contact = await alice.getEntity("contact-northern-engineer");
    expect(contact.fields.email).toBe("eng@northern.example");
    producer.delete("contact-northern-engineer");
    const feed = createGenericChangeFeed(producer.connection, {
      companyId: "company-a",
      authorizationHeader: async () => "Bearer machine-service-token",
      fetch: producer.fetch
    });
    const tombstone = (await feed.getChanges({ limit: 100 })).items.at(-1);
    expect(tombstone).toMatchObject({
      entityId: "contact-northern-engineer",
      eventType: "delete",
      entity: null
    });
    expect(JSON.stringify(tombstone)).not.toContain("northern.example");
  });
});
