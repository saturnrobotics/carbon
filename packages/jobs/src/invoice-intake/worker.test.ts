import { createHash, randomUUID } from "node:crypto";
import type { KyselyDatabase } from "@carbon/database/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { copyInvoiceAttachments } from "./attachments";
import { emptyInvoiceExtraction } from "./contracts";
import { registerInvoiceSource } from "./ingestion";
import {
  createGoogleInvoiceProvider,
  loadInvoiceProviderConfig
} from "./provider";
import { pendingInvoiceValidations } from "./validation";
import {
  type InvoiceWorkerContext,
  pendingInvoiceIntakes,
  runInvoiceIntake,
  runInvoiceMatch
} from "./worker";

const url = process.env.INVOICE_INTAKE_TEST_DATABASE_URL;
const enabledConfig = loadInvoiceProviderConfig({
  INVOICE_INTAKE_ENABLED: "true",
  INVOICE_AI_PROJECT: "example-project",
  INVOICE_AI_PRICE_VERIFIED_AT: "2026-09-06",
  INVOICE_AI_INPUT_PRICE_USD_PER_MILLION: "1.65",
  INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION: "9.9"
});
const bytes = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==",
    "base64"
  )
);
let db: Kysely<KyselyDatabase>;
beforeAll(() => {
  if (
    !url ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
  )
    throw new Error(
      "Set INVOICE_INTAKE_TEST_DATABASE_URL to an isolated local test database"
    );
  db = new Kysely<KyselyDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: url,
        max: 8,
        options: "-c app.sync_in_progress=true"
      })
    })
  });
});
afterAll(async () => {
  await db?.destroy();
});

const response = () =>
  Response.json({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify(emptyInvoiceExtraction()) }] }
      }
    ],
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 20,
      totalTokenCount: 1120
    },
    modelVersion: "fixture-version"
  });
function provider(
  completion: () => Promise<Response> = async () => response()
) {
  const paid = vi.fn(completion);
  return {
    paid,
    provider: createGoogleInvoiceProvider(enabledConfig, {
      fetch: vi.fn(async (url) => {
        if (String(url).includes("metadata.google.internal"))
          return Response.json({
            access_token: "fixture-token",
            token_type: "Bearer",
            expires_in: 3600
          });
        if (String(url).endsWith(":countTokens"))
          return Response.json({ totalTokens: 1000 });
        return paid();
      }) as typeof fetch
    })
  };
}
async function fixture(
  run: (context: InvoiceWorkerContext, userId: string) => Promise<void>
) {
  const userId = randomUUID();
  let companyId: string | undefined;
  try {
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.com` })
      .execute();
    const company = await db
      .insertInto("company")
      .values({ name: "Inference Worker Fixture", baseCurrencyCode: "USD" })
      .returning("id")
      .executeTakeFirstOrThrow();
    companyId = company.id;
    await db
      .insertInto("group")
      .values({
        id: `00000000-0000-${companyId.slice(0, 4)}-${companyId.slice(4, 8)}-${companyId.slice(8, 20)}`,
        name: "Fixture Employees",
        companyId
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    const type = await db
      .insertInto("employeeType")
      .values({ name: "Fixture", companyId })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("userToCompany")
      .values({ userId, companyId, role: "employee" })
      .execute();
    await db
      .insertInto("employee")
      .values({ id: userId, companyId, employeeTypeId: type.id, active: true })
      .execute();
    await db
      .insertInto("userPermission")
      .values({
        id: userId,
        permissions: {
          invoicing_view: [company.id],
          invoicing_create: [company.id]
        }
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          permissions: {
            invoicing_view: [company.id],
            invoicing_create: [company.id]
          }
        })
      )
      .execute();
    await db
      .insertInto("invoiceIntakeSettings")
      .values({ companyId, enabled: true, createdBy: userId })
      .execute();
    const intake = await db
      .insertInto("invoiceIntake")
      .values({ companyId, status: "Queued", createdBy: userId })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("invoiceIntakeSource")
      .values({
        companyId,
        intakeId: intake.id,
        kind: "upload",
        sourceKey: randomUUID(),
        createdBy: userId,
        storageBucket: "private",
        storagePath: `${companyId}/invoice-intake/fixture.png`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mediaType: "image/png",
        byteSize: bytes.length
      })
      .execute();
    const storage = {
      from: vi.fn(() => ({
        download: vi.fn(async () => ({ data: new Blob([bytes]), error: null })),
        upload: vi.fn(async () => ({ error: null }))
      }))
    } as unknown as InvoiceWorkerContext["storage"];
    await run(
      {
        db,
        storage,
        companyId,
        intakeId: intake.id,
        generation: 0,
        provider: provider().provider
      },
      userId
    );
  } finally {
    if (companyId) {
      await db
        .updateTable("invoiceIntake")
        .set({ activeExtractionId: null })
        .where("companyId", "=", companyId)
        .execute();
      await db.deleteFrom("company").where("id", "=", companyId).execute();
    }
    await db.deleteFrom("user").where("id", "=", userId).execute();
  }
}
const attempts = (c: InvoiceWorkerContext) =>
  db
    .selectFrom("documentExtraction")
    .selectAll()
    .where("companyId", "=", c.companyId)
    .where("intakeId", "=", c.intakeId)
    .orderBy("attemptNumber")
    .execute();
const review = (c: InvoiceWorkerContext) =>
  db
    .selectFrom("invoiceIntake")
    .selectAll()
    .where("companyId", "=", c.companyId)
    .where("id", "=", c.intakeId)
    .executeTakeFirstOrThrow();

// Real PostgreSQL admission/leases/transactions; HTTP is deliberately synthetic.
describe("durable invoice worker", () => {
  it("rejects signature-only images before token estimation or paid admission", async () =>
    fixture(async (c) => {
      const invalid = Uint8Array.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0
      ]);
      await db
        .updateTable("invoiceIntakeSource")
        .set({
          sha256: createHash("sha256").update(invalid).digest("hex"),
          byteSize: invalid.length
        })
        .where("companyId", "=", c.companyId)
        .execute();
      c.storage = {
        from: () => ({
          download: async () => ({ data: new Blob([invalid]), error: null })
        })
      } as unknown as InvoiceWorkerContext["storage"];
      const p = provider();
      await runInvoiceIntake({ ...c, provider: p.provider });
      expect(p.paid).not.toHaveBeenCalled();
      expect(await attempts(c)).toHaveLength(0);
      expect((await review(c)).lastErrorCode).toBe("invoice_image_invalid");
    }));

  it("hydrates private evidence with actual usage and cannot replay a completed review", async () =>
    fixture(async (c) => {
      const p = provider();
      c.provider = p.provider;
      expect((await runInvoiceIntake(c)).state).toBe("complete");
      expect((await review(c)).status).toBe("NeedsReview");
      const [attempt] = await attempts(c);
      expect(attempt?.status).toBe("completed");
      expect(Number(attempt?.actualCostUsd)).toBeCloseTo(0.002838);
      expect(attempt?.usage).toMatchObject({
        modelVersion: "fixture-version",
        thoughtTokens: 20
      });
      expect((await runInvoiceIntake(c)).state).toBe("stale");
      expect(p.paid).toHaveBeenCalledTimes(1);
    }));
  it("retains saved review/default metadata when hydrating the first selected document", async () =>
    fixture(async (c) => {
      const metadata = {
        _review: {
          mergeMode: "append",
          expectedInvoiceUpdatedAt: "example-token"
        },
        _defaults: { locationId: "example-location" },
        primarySourceSha256: createHash("sha256").update(bytes).digest("hex")
      };
      await db
        .updateTable("invoiceIntake")
        .set({ header: metadata })
        .where("companyId", "=", c.companyId)
        .where("id", "=", c.intakeId)
        .execute();
      c.provider = provider(async () => {
        const output = emptyInvoiceExtraction();
        output.header.invoiceNumber.value = "EXAMPLE-123";
        const payload = await response().json();
        payload.candidates[0].content.parts[0].text = JSON.stringify(output);
        return Response.json(payload);
      }).provider;
      expect((await runInvoiceIntake(c)).state).toBe("complete");
      const result = await review(c);
      expect(result.header).toMatchObject({
        ...metadata,
        invoiceNumber: "EXAMPLE-123"
      });
      expect(
        (result.header as Record<string, unknown>)._pendingExtractionReview
      ).toBeUndefined();
    }));
  it("rejects paused, cross-company and revoked operators before paid requests", async () =>
    fixture(async (c, userId) => {
      const p = provider();
      c.provider = p.provider;
      expect(
        (await runInvoiceIntake({ ...c, companyId: "other-fixture" })).state
      ).toBe("missing");
      await db
        .updateTable("invoiceIntakeSettings")
        .set({ enabled: false })
        .where("companyId", "=", c.companyId)
        .execute();
      expect((await runInvoiceIntake(c)).state).toBe("disabled");
      await db
        .updateTable("invoiceIntakeSettings")
        .set({ enabled: true })
        .where("companyId", "=", c.companyId)
        .execute();
      await db
        .updateTable("employee")
        .set({ active: false })
        .where("companyId", "=", c.companyId)
        .where("id", "=", userId)
        .execute();
      expect((await runInvoiceIntake(c)).state).toBe("disabled");
      expect(p.paid).not.toHaveBeenCalled();
    }));
  it("does not let deferred Gmail candidates block a verified receipt", async () =>
    fixture(async (c, userId) => {
      await db
        .insertInto("invoiceIntakeSource")
        .values({
          companyId: c.companyId,
          intakeId: c.intakeId,
          kind: "gmail",
          sourceKey: randomUUID(),
          createdBy: userId,
          storageBucket: "private",
          storagePath: `${c.companyId}/mercury/mail/other.png`,
          sha256: "a".repeat(64),
          mediaType: "image/png",
          byteSize: bytes.length
        })
        .execute();
      const p = provider();
      c.provider = p.provider;
      expect((await runInvoiceIntake(c)).state).toBe("complete");
      expect(p.paid).toHaveBeenCalledTimes(1);
    }));
  it("requires a primary for distinct files and reparses the selected later source", async () =>
    fixture(async (c, userId) => {
      const secondBytes = new Uint8Array(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2BABwAAEgABb/pjtwAAAABJRU5ErkJggg==",
          "base64"
        )
      );
      const sha256 = createHash("sha256").update(secondBytes).digest("hex");
      const secondPath = `${c.companyId}/invoice-intake/later-invoice.png`;
      await db
        .insertInto("invoiceIntakeSource")
        .values({
          companyId: c.companyId,
          intakeId: c.intakeId,
          kind: "upload",
          sourceKey: randomUUID(),
          createdBy: userId,
          storageBucket: "private",
          storagePath: secondPath,
          sha256,
          mediaType: "image/png",
          byteSize: secondBytes.length
        })
        .execute();
      const p = provider();
      c.provider = p.provider;
      expect((await runInvoiceIntake(c)).state).toBe("review");
      expect(p.paid).not.toHaveBeenCalled();
      expect((await review(c)).lastErrorCode).toBe(
        "invoice_source_selection_required"
      );
      const acknowledgement = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        reason: "Supporting bank receipt; invoice facts come from selected file"
      };
      await db
        .updateTable("invoiceIntake")
        .set({
          status: "Queued",
          generation: 1,
          revision: 1,
          header: {
            primarySourceSha256: sha256,
            sourceAcknowledgements: [acknowledgement]
          }
        })
        .where("companyId", "=", c.companyId)
        .where("id", "=", c.intakeId)
        .execute();
      const download = vi.fn(async (path: string) => ({
        data: new Blob([path === secondPath ? secondBytes : bytes]),
        error: null
      }));
      c.storage = {
        from: () => ({ download })
      } as unknown as InvoiceWorkerContext["storage"];
      expect((await runInvoiceIntake({ ...c, generation: 1 })).state).toBe(
        "complete"
      );
      expect(download).toHaveBeenCalledExactlyOnceWith(secondPath);
      expect((await attempts(c))[0]?.storagePath).toBe(secondPath);
      expect((await review(c)).header).toMatchObject({
        primarySourceSha256: sha256,
        sourceAcknowledgements: [acknowledgement]
      });
      expect(p.paid).toHaveBeenCalledTimes(1);
    }));
  it("invalidates Ready only when source registration introduces different bytes", async () =>
    fixture(async (c, userId) => {
      await runInvoiceIntake(c);
      const header = (await review(c)).header;
      await db
        .updateTable("invoiceIntake")
        .set({ status: "Ready" })
        .where("companyId", "=", c.companyId)
        .where("id", "=", c.intakeId)
        .execute();
      const duplicate = await registerInvoiceSource(
        db,
        c.storage,
        { companyId: c.companyId, userId },
        {
          kind: "upload",
          sourceKey: randomUUID(),
          bytes
        }
      );
      expect(duplicate.status).toBe("Ready");
      const added = await registerInvoiceSource(
        db,
        c.storage,
        { companyId: c.companyId, userId },
        {
          kind: "upload",
          sourceKey: randomUUID(),
          bytes: new Uint8Array(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2BABwAAEgABb/pjtwAAAABJRU5ErkJggg==",
              "base64"
            )
          ),
          existingIntakeId: c.intakeId
        }
      );
      expect(added.status).toBe("NeedsReview");
      expect((await review(c)).header).toEqual(header);
      expect((await runInvoiceIntake(c)).state).toBe("stale");
    }));
  it("never downloads or pays for a selected hash outside this intake", async () =>
    fixture(async (c) => {
      const p = provider();
      c.provider = p.provider;
      await db
        .updateTable("invoiceIntake")
        .set({ header: { primarySourceSha256: "a".repeat(64) } })
        .where("companyId", "=", c.companyId)
        .where("id", "=", c.intakeId)
        .execute();
      expect((await runInvoiceIntake(c)).state).toBe("review");
      expect(p.paid).not.toHaveBeenCalled();
      expect(c.storage.from).not.toHaveBeenCalled();
    }));
  it("serializes duplicate delivery and preserves two global slots", async () =>
    fixture(async (c, userId) => {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });
      const p = provider(async () => {
        started();
        await gate;
        return response();
      });
      c.provider = p.provider;
      const first = runInvoiceIntake(c);
      await start;
      expect((await runInvoiceIntake(c)).state).toBe("busy");
      const second = await db
        .insertInto("invoiceIntake")
        .values({ companyId: c.companyId, createdBy: userId, status: "Queued" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const source = await db
        .selectFrom("invoiceIntakeSource")
        .selectAll()
        .where("companyId", "=", c.companyId)
        .where("intakeId", "=", c.intakeId)
        .executeTakeFirstOrThrow();
      await db
        .insertInto("invoiceIntakeSource")
        .values({
          ...source,
          id: randomUUID(),
          intakeId: second.id,
          sourceKey: randomUUID()
        })
        .execute();
      const next = { ...c, intakeId: second.id };
      const secondRun = runInvoiceIntake(next);
      // Wait until both paid requests are durably admitted, without wall-clock sleeps.
      while (p.paid.mock.calls.length < 2)
        await new Promise((resolve) => setImmediate(resolve));
      expect(
        (await attempts(c)).filter((a) => a.status === "processing")
      ).toHaveLength(1);
      release();
      await Promise.all([first, secondRun]);
      expect(p.paid).toHaveBeenCalledTimes(2);
    }));
  it("reclaims an expired lease while a late response only updates its own bill", async () =>
    fixture(async (c) => {
      let release!: () => void,
        started!: () => void,
        count = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });
      const p = provider(async () => {
        if (++count === 1) {
          started();
          await gate;
        }
        return response();
      });
      c.provider = p.provider;
      const first = runInvoiceIntake(c);
      await start;
      await sql`UPDATE public."documentExtraction" SET "leaseUntil"=now()-interval '1 second' WHERE "companyId"=${c.companyId}`.execute(
        db
      );
      expect((await runInvoiceIntake(c)).state).toBe("complete");
      release();
      expect((await first).state).toBe("stale");
      const records = await attempts(c);
      expect(records).toHaveLength(2);
      expect(records.every((row) => row.actualCostUsd !== null)).toBe(true);
      expect((await review(c)).revision).toBe(1);
    }));
  it("keeps unsupported model candidates out of canonical review selections", async () =>
    fixture(async (c) => {
      await runInvoiceIntake(c);
      const original = (await review(c)).header;
      const p = provider(async () =>
        Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      supplierId: "not-an-admitted-supplier",
                      lines: []
                    })
                  }
                ]
              }
            }
          ],
          usageMetadata: {
            promptTokenCount: 1000,
            candidatesTokenCount: 100,
            totalTokenCount: 1100
          },
          modelVersion: "fixture-version"
        })
      );
      expect(
        (await runInvoiceMatch({ ...c, provider: p.provider, revision: 1 }))
          .state
      ).toBe("review");
      expect((await review(c)).header).toEqual(original);
      expect((await review(c)).lastErrorCode).toBe(
        "inference_candidate_invalid"
      );
      expect((await attempts(c))[1]?.actualCostUsd).not.toBeNull();
    }));
  it("keeps ambiguous reservations and shares the three attempt ceiling", async () =>
    fixture(async (c) => {
      const p = provider(
        async () => new Response("private provider response", { status: 429 })
      );
      c.provider = p.provider;
      for (let i = 0; i < 3; i++)
        expect((await runInvoiceIntake(c)).state).toBe("retry");
      expect((await runInvoiceIntake(c)).state).toBe("attempt_limit");
      expect(p.paid).toHaveBeenCalledTimes(3);
      expect(
        (await attempts(c)).every(
          (a) => a.actualCostUsd === null && Number(a.reservedCostUsd) > 0
        )
      ).toBe(true);
    }));
  it("does not overspend a concurrent company reservation", async () =>
    fixture(async (c) => {
      await db
        .updateTable("invoiceIntakeSettings")
        .set({ dailyBudgetUsd: 0.001 })
        .where("companyId", "=", c.companyId)
        .execute();
      const p = provider();
      c.provider = p.provider;
      expect((await runInvoiceIntake(c)).state).toBe("budget");
      expect(p.paid).not.toHaveBeenCalled();
      expect(await attempts(c)).toHaveLength(0);
    }));
  it("reconciles a late response while preserving a user's newer review", async () =>
    fixture(async (c) => {
      const p = provider(async () => {
        await db
          .updateTable("invoiceIntake")
          .set({
            revision: 1,
            status: "NeedsReview",
            header: { invoiceNumber: "manual" }
          })
          .where("companyId", "=", c.companyId)
          .where("id", "=", c.intakeId)
          .execute();
        return response();
      });
      c.provider = p.provider;
      expect((await runInvoiceIntake(c)).state).toBe("stale");
      expect((await review(c)).header).toEqual({ invoiceNumber: "manual" });
      expect((await attempts(c))[0]?.actualCostUsd).not.toBeNull();
    }));
  it("recovers committed extraction evidence without another provider request", async () =>
    fixture(async (c) => {
      const p = provider();
      c.provider = p.provider;
      await runInvoiceIntake(c);
      await db
        .updateTable("invoiceIntake")
        .set({ status: "Processing", revision: 0, header: {} })
        .where("companyId", "=", c.companyId)
        .where("id", "=", c.intakeId)
        .execute();
      expect((await runInvoiceIntake(c)).state).toBe("complete");
      expect(p.paid).toHaveBeenCalledTimes(1);
    }));
  it.each([
    "extract",
    "match"
  ] as const)("preserves review and billing when another source arrives during %s", async (operation) =>
    fixture(async (c, userId) => {
      if (operation === "match") await runInvoiceIntake(c);
      const header = { invoiceNumber: "reviewed-reference" };
      await db
        .updateTable("invoiceIntake")
        .set({ header })
        .where("companyId", "=", c.companyId)
        .where("id", "=", c.intakeId)
        .execute();
      await db
        .insertInto("invoiceIntakeLine")
        .values({
          companyId: c.companyId,
          intakeId: c.intakeId,
          lineKey: "reviewed-line",
          sortOrder: 0,
          description: "Reviewed description",
          lineType: "Comment",
          createdBy: userId
        })
        .execute();
      const before = await review(c);
      const responseData =
        operation === "extract"
          ? emptyInvoiceExtraction()
          : { supplierId: null, lines: [] };
      const p = provider(async () => {
        expect((await review(c)).status).toBe("Processing");
        const registered = await registerInvoiceSource(
          db,
          c.storage,
          { companyId: c.companyId, userId },
          {
            kind: "upload",
            sourceKey: randomUUID(),
            fileName: "duplicate.png",
            bytes
          }
        );
        expect(registered.intakeId).toBe(c.intakeId);
        expect(registered.existing).toBe(true);
        return Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: JSON.stringify(responseData) }] }
            }
          ],
          usageMetadata: {
            promptTokenCount: 1000,
            candidatesTokenCount: 100,
            thoughtsTokenCount: 20,
            totalTokenCount: 1120
          },
          modelVersion: "fixture-version"
        });
      });
      c.provider = p.provider;
      const completed =
        operation === "extract"
          ? await runInvoiceIntake(c)
          : await runInvoiceMatch({ ...c, revision: before.revision });
      expect(completed.state).toBe("stale");
      expect(await review(c)).toMatchObject({
        status: "NeedsReview",
        revision: before.revision + 1,
        activeExtractionId: null,
        lastErrorCode: "invoice_source_changed",
        header
      });
      expect(
        await db
          .selectFrom("invoiceIntakeLine")
          .select(["lineKey", "description", "lineType"])
          .where("companyId", "=", c.companyId)
          .where("intakeId", "=", c.intakeId)
          .execute()
      ).toEqual([
        {
          lineKey: "reviewed-line",
          description: "Reviewed description",
          lineType: "Comment"
        }
      ]);
      const evidence = (await attempts(c)).at(-1)!;
      expect(evidence.status).toBe("completed");
      expect(evidence.extractedData).toEqual(responseData);
      expect(evidence.billingState).toBe("Reconciled");
      expect(Number(evidence.actualCostUsd)).toBeCloseTo(0.002838);
      expect(
        (await pendingInvoiceValidations(db)).some(
          (pending) => pending.intakeId === c.intakeId
        )
      ).toBe(false);
      expect((await runInvoiceIntake(c)).state).toBe("stale");
      expect(await attempts(c)).toHaveLength(operation === "extract" ? 1 : 2);
      expect(p.paid).toHaveBeenCalledTimes(1);
    }));
  it.each([
    "gmail",
    "unavailable"
  ])("refuses paid matching without a current verified receipt (%s)", async (reason) =>
    fixture(async (c) => {
      await runInvoiceIntake(c);
      if (reason === "gmail")
        await db
          .updateTable("invoiceIntakeSource")
          .set({ kind: "gmail" })
          .where("companyId", "=", c.companyId)
          .where("intakeId", "=", c.intakeId)
          .execute();
      else
        c.storage = {
          from: () => ({ download: async () => ({ data: null, error: null }) })
        } as unknown as InvoiceWorkerContext["storage"];
      const p = provider();
      expect(
        (await runInvoiceMatch({ ...c, provider: p.provider, revision: 1 }))
          .state
      ).toBe("review");
      expect(p.paid).not.toHaveBeenCalled();
      expect(await attempts(c)).toHaveLength(1);
    }));
  it("refuses paid matching of facts extracted from a different source document", async () =>
    fixture(async (c, userId) => {
      await runInvoiceIntake(c);
      await db
        .updateTable("invoiceIntakeSource")
        .set({ kind: "gmail" })
        .where("companyId", "=", c.companyId)
        .where("intakeId", "=", c.intakeId)
        .execute();
      const replacement = new Uint8Array(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2BABwAAEgABb/pjtwAAAABJRU5ErkJggg==",
          "base64"
        )
      );
      await db
        .insertInto("invoiceIntakeSource")
        .values({
          companyId: c.companyId,
          intakeId: c.intakeId,
          kind: "mercury",
          sourceKey: randomUUID(),
          createdBy: userId,
          storageBucket: "private",
          storagePath: `${c.companyId}/mercury/payment/current.png`,
          sha256: createHash("sha256").update(replacement).digest("hex"),
          mediaType: "image/png",
          byteSize: replacement.length
        })
        .execute();
      c.storage = {
        from: () => ({
          download: async () => ({ data: new Blob([replacement]), error: null })
        })
      } as unknown as InvoiceWorkerContext["storage"];
      const p = provider();
      await runInvoiceMatch({ ...c, provider: p.provider, revision: 1 });
      expect(p.paid).not.toHaveBeenCalled();
      expect((await review(c)).lastErrorCode).toBe(
        "invoice_extraction_source_changed"
      );
    }));
  it("preserves extracted fields when optional matching fails and counts both operations", async () =>
    fixture(async (c) => {
      const p = provider();
      c.provider = p.provider;
      await runInvoiceIntake(c);
      const original = (await review(c)).header;
      const broken = provider(
        async () => new Response("private", { status: 500 })
      );
      expect(
        (
          await runInvoiceMatch({
            ...c,
            provider: broken.provider,
            revision: 1
          })
        ).state
      ).toBe("review");
      expect((await review(c)).header).toEqual(original);
      expect((await attempts(c)).map((a) => a.operation)).toEqual([
        "extract",
        "match"
      ]);
      expect(
        (
          await runInvoiceMatch({
            ...c,
            provider: broken.provider,
            revision: 1
          })
        ).state
      ).toBe("review");
      expect(
        (
          await runInvoiceMatch({
            ...c,
            provider: broken.provider,
            revision: 1
          })
        ).state
      ).toBe("attempt_limit");
      expect(broken.paid).toHaveBeenCalledTimes(2);
    }));
  it("finds lost event dispatch without requeueing a review", async () =>
    fixture(async (c) => {
      expect(
        (await pendingInvoiceIntakes(db)).some(
          (row) => row.intakeId === c.intakeId
        )
      ).toBe(true);
      await runInvoiceIntake(c);
      expect(
        (await pendingInvoiceIntakes(db)).some(
          (row) => row.intakeId === c.intakeId
        )
      ).toBe(false);
    }));
  it("charges reservations in their UTC admission window rather than upload time", async () =>
    fixture(async (c) => {
      const p = provider(async () => new Response("busy", { status: 429 }));
      c.provider = p.provider;
      await runInvoiceIntake(c);
      await sql`UPDATE public."documentExtraction" SET "reservedAt"=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 second'
      WHERE "companyId"=${c.companyId}`.execute(db);
      await db
        .updateTable("invoiceIntakeSettings")
        .set({
          dailyBudgetUsd:
            Number((await attempts(c))[0]!.reservedCostUsd) + 0.001,
          monthlyBudgetUsd: 50
        })
        .where("companyId", "=", c.companyId)
        .execute();
      expect((await runInvoiceIntake(c)).state).toBe("retry");
      expect(p.paid).toHaveBeenCalledTimes(2);
    }));
  it("rejects legacy wildcard-only permission arrays", async () =>
    fixture(async (c, userId) => {
      await db
        .updateTable("userPermission")
        .set({
          permissions: { invoicing_view: ["0"], invoicing_create: ["0"] }
        })
        .where("id", "=", userId)
        .execute();
      const p = provider();
      c.provider = p.provider;
      expect((await runInvoiceIntake(c)).state).toBe("disabled");
      expect(p.paid).not.toHaveBeenCalled();
    }));
  it.each([
    "ordinary",
    "gmail",
    "archived"
  ])("copies only approved attachment identities idempotently (%s)", async (scenario) =>
    fixture(async (c, userId) => {
      const supplier = await db
        .insertInto("supplier")
        .values({
          companyId: c.companyId,
          createdBy: userId,
          name: "Attachment Fixture Supplier",
          readableId: randomUUID()
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const interaction = await db
        .insertInto("supplierInteraction")
        .values({ companyId: c.companyId, supplierId: supplier.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      const invoice = await db
        .insertInto("purchaseInvoice")
        .values({
          companyId: c.companyId,
          createdBy: userId,
          supplierInteractionId: interaction.id,
          invoiceId: randomUUID(),
          currencyCode: "USD",
          status: "Draft"
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("invoiceIntake")
        .set({
          status: "Approved",
          purchaseInvoiceId: invoice.id,
          approvedBy: userId,
          approvedAt: sql`now()`,
          attachmentStatus: "Pending",
          approvalSnapshot: {
            sourceSha256s: [createHash("sha256").update(bytes).digest("hex")]
          }
        })
        .where("companyId", "=", c.companyId)
        .where("id", "=", c.intakeId)
        .execute();
      if (scenario === "archived") {
        await db
          .updateTable("invoiceIntakeSource")
          .set({ kind: "mercury", provenance: { current: false } })
          .where("companyId", "=", c.companyId)
          .where("intakeId", "=", c.intakeId)
          .execute();
        await db
          .insertInto("invoiceIntakeSource")
          .values({
            companyId: c.companyId,
            intakeId: c.intakeId,
            kind: "mercury",
            sourceKey: randomUUID(),
            createdBy: userId,
            storageBucket: "private",
            storagePath: `${c.companyId}/mercury/payment/unapproved.png`,
            sha256: "b".repeat(64),
            mediaType: "image/png",
            byteSize: bytes.length,
            provenance: { current: true }
          })
          .execute();
      }
      if (scenario === "gmail")
        await db
          .insertInto("invoiceIntakeSource")
          .values({
            companyId: c.companyId,
            intakeId: c.intakeId,
            kind: "gmail",
            sourceKey: randomUUID(),
            createdBy: userId,
            storageBucket: "private",
            storagePath: `${c.companyId}/mercury/mail/other.png`,
            sha256: "a".repeat(64),
            mediaType: "image/png",
            byteSize: bytes.length
          })
          .execute();
      const objects = new Map<string, Uint8Array>([
        [`${c.companyId}/invoice-intake/fixture.png`, bytes]
      ]);
      const upload = vi.fn(async (path: string, data: Uint8Array) => {
        objects.set(path, data);
        return { error: null };
      });
      const download = vi.fn(async (path: string) => ({
        data: objects.has(path)
          ? new Blob([Buffer.from(objects.get(path)!)])
          : null,
        error: null
      }));
      c.storage = {
        from: () => ({ upload, download })
      } as unknown as InvoiceWorkerContext["storage"];
      expect((await copyInvoiceAttachments(c)).state).toBe("complete");
      expect((await copyInvoiceAttachments(c)).state).toBe("complete");
      expect(upload).toHaveBeenCalledTimes(1);
      expect((await review(c)).attachmentStatus).toBe("Complete");
      const documents = await db
        .selectFrom("document")
        .select(["path", "sourceDocument", "sourceDocumentId", "size"])
        .where("companyId", "=", c.companyId)
        .execute();
      expect(documents).toHaveLength(1);
      expect(documents[0]?.sourceDocumentId).toBe(invoice.id);
      expect(documents[0]?.size).toBe(0);
      expect(documents[0]?.path).toContain(
        `/invoice-intake/${c.intakeId}/invoice/${invoice.id}/`
      );
      const unchanged = await db
        .selectFrom("purchaseInvoice")
        .select("status")
        .where("companyId", "=", c.companyId)
        .where("id", "=", invoice.id)
        .executeTakeFirstOrThrow();
      expect(unchanged.status).toBe("Draft");
      expect(
        await db
          .selectFrom("purchaseInvoiceLine")
          .select("id")
          .where("companyId", "=", c.companyId)
          .where("invoiceId", "=", invoice.id)
          .execute()
      ).toHaveLength(0);
    }));
});
