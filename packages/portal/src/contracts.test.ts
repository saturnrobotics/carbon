import { describe, expect, it } from "vitest";
import {
  commandProposalSchema,
  documentVersionSchema,
  evidenceSchema,
  intakeProposalSchema,
  portalJsonSchemas,
  portalOpenApiDocument,
  principalSchema,
  queryRequestSchema,
  sourceCapabilitySchema,
  sourceEntityRequestSchema,
  sourceEntitySchema,
  sourcePageSchema
} from "./contracts";
import {
  assertDisposableLocalDatabaseUrl,
  getDisposableLocalDatabaseUrl,
  PORTAL_TEST_DATABASE_DISPOSABLE,
  PORTAL_TEST_DATABASE_URL
} from "./test/database";
import { syntheticPortalFixtures } from "./test/synthetic";

const observedAt = "2026-09-07T12:00:00.000Z";
const hash = "a".repeat(64);

const examples = [
  [
    principalSchema,
    {
      kind: "human",
      actorId: "usr_example_alex",
      companyId: "cmp_example_alpha",
      callerId: "portal-web@example.invalid",
      sourceIdentity: {
        issuer: "https://accounts.example.com",
        subject: "subject-alex"
      },
      policyVersion: "policy-4",
      capabilities: ["source.entity.read"]
    }
  ],
  [sourceCapabilitySchema, "source.entity.read"],
  [
    sourceEntityRequestSchema,
    { sourceId: "carbon", entityId: "item_synthetic", kind: "item" }
  ],
  [
    sourceEntitySchema,
    {
      kind: "item",
      title: "Synthetic assembly",
      description: null,
      fields: { itemId: "SYN-100", revision: "A" },
      sourceRevision: "projection:synthetic",
      observedAt
    }
  ],
  [
    queryRequestSchema,
    {
      requestId: "req_example_01",
      text: "Which manual applies to motor MTR-100 rev B?",
      mode: "locate",
      context: { source: "carbon:items", entityId: "carbon:item:MTR-100-B" },
      locale: "en-US"
    }
  ],
  [
    evidenceSchema,
    {
      id: "evidence:manual:mtr-100-b:p4",
      sourceId: "upload:manuals",
      documentVersionId: "upload:manual:mtr-100-b:v3",
      sourceRevision: "3",
      title: "MTR-100 Revision B Manual",
      excerpt: "Use the revision B wiring procedure.",
      page: 4,
      sourceUri: "https://example.com/manuals/mtr-100-b",
      observedAt,
      policyVersion: "policy-4",
      freshness: "current"
    }
  ],
  [
    sourcePageSchema,
    {
      items: [{ id: "carbon:item:MTR-100-B", name: "MTR-100" }],
      nextCursor: "cursor:carbon:items:2",
      observedAt,
      sourceRevision: "items-42",
      status: "complete"
    }
  ],
  [
    documentVersionSchema,
    {
      id: "upload:manual:mtr-100-b:v3",
      documentId: "upload:manual:mtr-100-b",
      sourceRevision: "3",
      contentHash: hash,
      objectKey: "documents/example-manual/v3.pdf",
      objectGeneration: "3",
      mimeType: "application/pdf",
      byteCount: 2048,
      extractedTextKey: "documents/example-manual/v3.txt",
      observedAt,
      parserVersion: "parser-1",
      extractionStatus: "ready"
    }
  ],
  [
    intakeProposalSchema,
    {
      id: "intake:receipt:example-01",
      version: 2,
      sourceId: "upload:intake",
      document: {
        title: "Synthetic motor receipt",
        kind: "other",
        classification: "internal"
      },
      extracted: { itemIdentifier: "MTR-100-B", quantity: "2" },
      provenance: {
        itemIdentifier: {
          evidenceIds: ["evidence:receipt:example-01:item"],
          confidence: 0.97
        }
      },
      unresolved: [],
      reviewDecisions: [
        {
          field: "quantity",
          value: "2",
          decision: "corrected"
        }
      ]
    }
  ],
  [
    commandProposalSchema,
    {
      id: "command:ticket:example-01",
      version: 1,
      action: "kanban.ticket.create",
      target: { sourceId: "kanban:example", resourceId: "board:maintenance" },
      payload: {
        boardId: "board:maintenance",
        initialColumnId: "column:inbox",
        title: "Inspect synthetic motor",
        description: "Check the revision label before installation.",
        dueDate: "2026-09-14",
        businessTimezone: "America/New_York"
      },
      payloadHash: hash,
      idempotencyKey: "ticket:example-01"
    }
  ]
] as const;

describe("portal contracts", () => {
  it.each(examples)("round-trips a valid %s value", (schema, value) => {
    const parsed = schema.parse(value);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(value);
  });

  it("rejects caller and identity fields not in the verified principal contract", () => {
    const forgedHuman = {
      ...(examples[0][1] as Record<string, unknown>),
      email: "forged@example.com"
    };
    const forgedMachine = {
      kind: "machine",
      callerId: "portal-indexer@example.invalid",
      actorId: "usr_forged",
      companyId: "cmp_example_alpha",
      sourceIds: ["upload:manuals"],
      policyVersion: "policy-4",
      capabilities: ["source.index.read"]
    };

    expect(principalSchema.safeParse(forgedHuman).success).toBe(false);
    expect(principalSchema.safeParse(forgedMachine).success).toBe(false);
  });

  it("rejects oversized query and command payloads", () => {
    expect(
      queryRequestSchema.safeParse({
        requestId: "req_example_oversized",
        text: "x".repeat(8001),
        mode: "auto",
        locale: "en-US"
      }).success
    ).toBe(false);

    const command = examples[examples.length - 1]![1] as Record<string, any>;
    expect(
      commandProposalSchema.safeParse({
        ...command,
        payload: {
          ...command.payload,
          description: "x".repeat(16_001)
        }
      }).success
    ).toBe(false);
  });

  it("requires clarification for an incomplete procurement proposal", () => {
    const incomplete = {
      id: "command:procurement:example-01",
      version: 1,
      action: "carbon.procurement.draft",
      target: { sourceId: "carbon:purchasing", resourceId: "draft:new" },
      payload: {
        itemId: "item:mtr-100-b",
        itemRevision: "B",
        purchaseUnitOfMeasureCode: "EA",
        requestedArrivalDate: "2026-10-01"
      },
      payloadHash: hash,
      idempotencyKey: "procurement:example-01"
    };

    expect(commandProposalSchema.safeParse(incomplete).success).toBe(false);
    expect(
      commandProposalSchema.safeParse({
        ...incomplete,
        clarification: {
          field: "supplierId",
          choices: ["supplier:example-a", "supplier:example-b"]
        }
      }).success
    ).toBe(true);
  });

  it("exports JSON Schema and OpenAPI components from every runtime schema", () => {
    expect(Object.keys(portalJsonSchemas)).toEqual([
      "Principal",
      "SourceCapability",
      "QueryRequest",
      "SourceEntityRequest",
      "SourceEntity",
      "Evidence",
      "SourcePage",
      "DocumentVersion",
      "IntakeProposal",
      "CommandProposal"
    ]);
    expect(portalJsonSchemas.Principal).toMatchObject({
      $schema: expect.stringContaining("json-schema"),
      oneOf: expect.any(Array)
    });
    expect(portalOpenApiDocument).toMatchObject({
      openapi: "3.1.0",
      components: { schemas: portalJsonSchemas }
    });
  });
});

describe("synthetic portal fixtures", () => {
  it("model two isolated companies and access boundaries deterministically", () => {
    expect(syntheticPortalFixtures.companies).toHaveLength(2);
    expect(syntheticPortalFixtures.users).toHaveLength(3);
    expect(syntheticPortalFixtures.access.alex.boardIds).not.toEqual(
      syntheticPortalFixtures.access.blair.boardIds
    );
    expect(syntheticPortalFixtures.access.alex.documentIds).not.toEqual(
      syntheticPortalFixtures.access.blair.documentIds
    );
    expect(syntheticPortalFixtures.duplicateDocuments[0]?.contentHash).toBe(
      syntheticPortalFixtures.duplicateDocuments[1]?.contentHash
    );
    expect(syntheticPortalFixtures.duplicateDocuments[0]?.companyId).not.toBe(
      syntheticPortalFixtures.duplicateDocuments[1]?.companyId
    );
    expect(syntheticPortalFixtures.revokedMembership.revokedAt).toBeTruthy();
    expect(
      syntheticPortalFixtures.correctedReceipt.reviewDecisions
    ).toContainEqual(
      expect.objectContaining({ field: "quantity", decision: "corrected" })
    );
    expect(syntheticPortalFixtures.motors[0]?.revision).not.toBe(
      syntheticPortalFixtures.motors[1]?.revision
    );
    expect(syntheticPortalFixtures.injectionDocument.text).toContain(
      "ignore previous instructions"
    );
  });

  it("contains no live deployment values", () => {
    const serialized = JSON.stringify(syntheticPortalFixtures);
    expect(serialized).not.toMatch(
      /private-company|tailscale|googleapis\.com|supabase\.co|cloudrun/i
    );
  });
});

describe("disposable database guard", () => {
  const localUrl =
    "postgresql://portal_runner:synthetic@127.0.0.1:55432/portal_test";

  it("accepts only an explicitly marked, isolated local portal database", () => {
    expect(assertDisposableLocalDatabaseUrl(localUrl, "1").href).toBe(
      `${localUrl}`
    );
    expect(
      getDisposableLocalDatabaseUrl({
        [PORTAL_TEST_DATABASE_URL]: localUrl,
        [PORTAL_TEST_DATABASE_DISPOSABLE]: "1"
      })
    ).toBe(localUrl);
  });

  it.each([
    [
      "remote host",
      "postgresql://user:pass@db.example.com:55432/portal_test",
      "1"
    ],
    ["default port", "postgresql://user:pass@127.0.0.1:5432/portal_test", "1"],
    ["wrong database", "postgresql://user:pass@127.0.0.1:55432/postgres", "1"],
    [
      "privileged user",
      "postgresql://postgres:pass@127.0.0.1:55432/portal_test",
      "1"
    ],
    ["missing marker", localUrl, undefined]
  ])("rejects a %s target", (_name, value, marker) => {
    expect(() => assertDisposableLocalDatabaseUrl(value, marker)).toThrow(
      /disposable local portal test database/i
    );
  });
});
