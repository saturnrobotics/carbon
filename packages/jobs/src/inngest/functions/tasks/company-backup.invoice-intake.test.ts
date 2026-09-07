import { randomUUID } from "node:crypto";
import type { KyselyDatabase } from "@carbon/database/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  bindValue,
  type ColumnInfo,
  getCompanyTableCatalog,
  rewriteStoragePath,
  type TableInfo
} from "./company-backup";
import {
  buildIdMaps,
  buildRowTransforms,
  findDanglingReferences
} from "./company-backup.transforms";

type Context = Parameters<typeof buildRowTransforms>[2];
const context: Context = {
  remap: true,
  sourceCompanyId: "source-company",
  companyId: "target-company",
  userId: "importer",
  targetGroupId: null,
  idMaps: new Map([
    ["mercuryTransactionImport", new Map([["payment-old", "payment-new"]])],
    ["invoiceIntake", new Map([["intake-old", "intake-new"]])],
    ["supplier", new Map([["supplier-old", "supplier-new"]])],
    ["item", new Map([["item-old", "item-new"]])],
    ["supplierPart", new Map([["part-old", "part-new"]])]
  ]),
  idRewrite: new Map([
    ["intake-old", "intake-new"],
    ["payment-old", "payment-new"]
  ])
};
function table(
  name: string,
  row: Record<string, unknown>,
  refs: Record<string, string> = {}
): TableInfo {
  return {
    name,
    columns: Object.keys(row).map((name) => ({
      name,
      dataType: "text",
      udtName: "text",
      isNullable: true,
      isGenerated: false,
      hasDefault: false
    })),
    foreignKeys: Object.entries(refs).map(([column, refTable]) => ({
      column,
      refTable,
      refColumn: "id"
    })),
    scope: { kind: "direct", column: "companyId" },
    scopeColumn: "companyId",
    pkColumns: ["id", "companyId"],
    uniqueColumns: [],
    hasId: false
  };
}
function apply(
  name: string,
  row: Record<string, unknown>,
  refs: Record<string, string> = {},
  ctx = context
) {
  const t = table(name, row, refs);
  const transforms = buildRowTransforms(t, t.columns, ctx);
  return Object.fromEntries(
    t.columns.map((col, index) => [col.name, transforms[index]!(row[col.name])])
  );
}

describe("invoice evidence in company backups", () => {
  it("rewrites only typed private source paths in step with restored files", () => {
    const path = "source-company/invoice-intake/intake-old/source/receipt.pdf";
    const out = apply(
      "invoiceIntakeSource",
      {
        companyId: "source-company",
        storagePath: path,
        mercuryImportId: "payment-old",
        provenance: { path, mercuryImportId: "payment-old", note: path }
      },
      { mercuryImportId: "mercuryTransactionImport" }
    );
    expect(out.storagePath).toBe(
      rewriteStoragePath(
        path,
        context.sourceCompanyId,
        context.companyId,
        context.idRewrite
      )
    );
    expect(out.mercuryImportId).toBe("payment-new");
    expect(out.provenance).toEqual({
      path: out.storagePath,
      mercuryImportId: "payment-new",
      note: path
    });
    expect(
      apply("documentExtraction", {
        storagePath: path,
        sourceDocumentId: "intake-old"
      })
    ).toEqual({ storagePath: out.storagePath, sourceDocumentId: "intake-new" });
    expect(apply("document", { path, sourceDocumentId: "intake-old" })).toEqual(
      { path: out.storagePath, sourceDocumentId: "intake-new" }
    );
  });
  it("rewrites Mercury attachment paths without rewriting raw email or invoice evidence", () => {
    const row = {
      attachments: [
        {
          path: "source-company/mercury/payment-old/a.pdf",
          source: "gmail",
          fileName: "invoice.pdf",
          mailbox: "invoices@example.com",
          messageId: "message"
        }
      ],
      invoiceEvidence: [{ subject: "source-company/mercury/payment-old/a.pdf" }]
    };
    const out = apply("mercuryTransactionImport", row);
    expect(out.attachments).toEqual([
      {
        ...row.attachments[0],
        path: "target-company/mercury/payment-new/a.pdf"
      }
    ]);
    expect(out.invoiceEvidence).toEqual(row.invoiceEvidence);
  });
  it("refuses foreign, malformed and traversing financial object references", () => {
    expect(() =>
      apply("document", { path: "other-company/invoice-intake/a.pdf" })
    ).toThrow("invalid financial source path");
    for (const path of [
      "other-company/mercury/a.pdf",
      "https://files.example.com/a.pdf",
      "source-company/a/../b.pdf",
      "source-company//a.pdf",
      "source-company/a\\b.pdf"
    ]) {
      expect(() => apply("invoiceIntakeSource", { storagePath: path })).toThrow(
        "invalid financial source path"
      );
      expect(() =>
        apply("mercuryTransactionImport", { attachments: [{ path }] })
      ).toThrow("invalid financial source path");
    }
  });
  it("disables connected processing and resets foreign backfill progress", () => {
    expect(
      apply("invoiceIntakeSettings", {
        enabled: true,
        automaticMercuryIntake: true,
        backfillStatus: "Running",
        backfillCursor: { id: "old" },
        backfillUpperBound: "2026-09-01T00:00:00Z",
        backfillCounts: { processed: 42 },
        lastErrorCode: "old",
        dailyBudgetUsd: 5
      })
    ).toEqual({
      enabled: false,
      automaticMercuryIntake: false,
      backfillStatus: "Idle",
      backfillCursor: null,
      backfillUpperBound: null,
      backfillCounts: {},
      lastErrorCode: null,
      dailyBudgetUsd: 5
    });
    expect(
      apply("mercurySyncSettings", { enabled: true, gmailEnabled: true })
    ).toEqual({ enabled: false, gmailEnabled: false });
  });
  it("clears unfinished proposals and leases while retaining evidence and billing history", () => {
    const raw = {
      supplier: { value: "Synthetic Supplier" },
      candidates: ["item-old"]
    };
    expect(
      apply("invoiceIntake", {
        status: "Processing",
        activeExtractionId: "attempt",
        newSupplier: { name: "proposed" },
        header: raw
      })
    ).toEqual({
      status: "NeedsReview",
      activeExtractionId: null,
      newSupplier: null,
      header: raw
    });
    expect(
      apply(
        "invoiceIntakeLine",
        {
          itemId: "item-old",
          newItem: { type: "Part" },
          review: { candidateIds: ["item-old"] },
          raw
        },
        { itemId: "item" }
      )
    ).toEqual({ itemId: "item-new", newItem: null, review: {}, raw });
    expect(
      apply("documentExtraction", {
        status: "processing",
        claimToken: "claim",
        leaseUntil: "2026-09-01T00:00:00Z",
        filteredData: raw,
        extractedData: raw,
        reservedCostUsd: 0.1,
        actualCostUsd: 0.05
      })
    ).toEqual({
      status: "failed",
      claimToken: null,
      leaseUntil: null,
      filteredData: null,
      extractedData: raw,
      reservedCostUsd: 0.1,
      actualCostUsd: 0.05
    });
  });
  it("keeps completed approval and confirmed recognition mappings usable", () => {
    for (const status of ["Approved", "Linked", "Ignored"])
      expect(
        apply("invoiceIntake", {
          status,
          approvalSnapshot: { source: "item-old" }
        }).status
      ).toBe(status);
    expect(
      apply(
        "invoiceRecognitionRule",
        {
          supplierId: "supplier-old",
          itemId: "item-old",
          supplierPartId: "part-old",
          conversionFactor: 12,
          sourceText: "Package of 12",
          matchKey: "packaged-part",
          active: true
        },
        {
          supplierId: "supplier",
          itemId: "item",
          supplierPartId: "supplierPart"
        }
      )
    ).toEqual({
      supplierId: "supplier-new",
      itemId: "item-new",
      supplierPartId: "part-new",
      conversionFactor: 12,
      sourceText: "Package of 12",
      matchKey: "packaged-part",
      active: true
    });
  });
  it("preserves exact same-company snapshots", () => {
    const row = {
      status: "Processing",
      claimToken: "claim",
      extractedData: { total: 12 },
      storagePath: "source-company/invoice-intake/intake-old/source/a.pdf"
    };
    expect(
      apply("documentExtraction", row, {}, { ...context, remap: false })
    ).toEqual(row);
  });
});

const databaseUrl = process.env.INVOICE_INTAKE_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  "invoice backup transforms against migrated PostgreSQL",
  () => {
    it("restores the new FK cycle, source paths and recognition into a different company without dangling IDs", async () => {
      if (
        !databaseUrl ||
        !["localhost", "127.0.0.1", "[::1]"].includes(
          new URL(databaseUrl).hostname
        )
      )
        throw new Error("Use an isolated local test database");
      const db = new Kysely<KyselyDatabase>({
        dialect: new PostgresDialect({
          pool: new pg.Pool({ connectionString: databaseUrl })
        })
      });
      const rollback = new Error("synthetic_restore_rollback");
      try {
        await expect(
          db.transaction().execute(async (trx) => {
            await sql`SET LOCAL "app.sync_in_progress"='true'`.execute(trx);
            const userId = randomUUID();
            await trx
              .insertInto("user")
              .values({ id: userId, email: `${userId}@example.com` })
              .execute();
            const companies = await trx
              .insertInto("company")
              .values([
                { name: "Backup Source Fixture", baseCurrencyCode: "USD" },
                { name: "Backup Target Fixture", baseCurrencyCode: "USD" }
              ])
              .returning("id")
              .execute();
            const sourceCompanyId = companies[0]!.id;
            const companyId = companies[1]!.id;
            const supplier = await trx
              .insertInto("supplier")
              .values({
                name: "Synthetic Restored Supplier",
                readableId: "SYNTHETIC",
                companyId: sourceCompanyId,
                createdBy: userId
              })
              .returning("id")
              .executeTakeFirstOrThrow();
            const intake = await trx
              .insertInto("invoiceIntake")
              .values({
                companyId: sourceCompanyId,
                createdBy: userId,
                supplierId: supplier.id,
                status: "Processing",
                newSupplier: { name: "unconfirmed" }
              })
              .returning("id")
              .executeTakeFirstOrThrow();
            await trx
              .insertInto("invoiceIntakeSettings")
              .values({
                companyId: sourceCompanyId,
                createdBy: userId,
                enabled: true,
                backfillStatus: "Running",
                backfillUpperBound: sql<string>`now()`
              })
              .execute();
            const path = `${sourceCompanyId}/invoice-intake/${intake.id}/source/receipt.pdf`;
            await trx
              .insertInto("invoiceIntakeSource")
              .values({
                companyId: sourceCompanyId,
                intakeId: intake.id,
                kind: "upload",
                sourceKey: "synthetic-source",
                createdBy: userId,
                storageBucket: "private",
                storagePath: path,
                sha256: "a".repeat(64),
                mediaType: "application/pdf",
                byteSize: 12
              })
              .execute();
            await trx
              .insertInto("invoiceIntakeLine")
              .values({
                companyId: sourceCompanyId,
                intakeId: intake.id,
                lineKey: "1",
                sortOrder: 1,
                createdBy: userId,
                raw: { description: "synthetic raw evidence" },
                newItem: { type: "Part" }
              })
              .execute();
            const attempt = await trx
              .insertInto("documentExtraction")
              .values({
                companyId: sourceCompanyId,
                intakeId: intake.id,
                generation: 0,
                inputRevision: 0,
                attemptNumber: 1,
                operation: "extract",
                sourceDocument: "Invoice Intake",
                sourceDocumentId: intake.id,
                documentType: "purchaseInvoice",
                storagePath: path,
                createdBy: userId,
                status: "processing",
                claimToken: randomUUID(),
                leaseUntil: sql<string>`now()+interval '5 minutes'`
              })
              .returning("id")
              .executeTakeFirstOrThrow();
            await trx
              .updateTable("invoiceIntake")
              .set({ activeExtractionId: attempt.id })
              .where("companyId", "=", sourceCompanyId)
              .where("id", "=", intake.id)
              .execute();
            await trx
              .insertInto("invoiceRecognitionRule")
              .values({
                companyId: sourceCompanyId,
                kind: "supplierAlias",
                matchKey: "synthetic",
                sourceText: "Synthetic",
                supplierId: supplier.id,
                intakeId: intake.id,
                createdBy: userId
              })
              .execute();
            const live = await getCompanyTableCatalog(trx);
            const names = [
              "supplier",
              "invoiceIntake",
              "invoiceIntakeSettings",
              "invoiceIntakeSource",
              "invoiceIntakeLine",
              "documentExtraction",
              "invoiceRecognitionRule"
            ];
            const tables = names.map(
              (name) => live.tables.find((t) => t.name === name)!
            );
            expect(tables.every(Boolean)).toBe(true);
            const data: Record<string, Record<string, unknown>[]> = {};
            for (const name of names)
              data[name] = (
                await sql<
                  Record<string, unknown>
                >`SELECT * FROM ${sql.id(name)} WHERE "companyId"=${sourceCompanyId}`.execute(
                  trx
                )
              ).rows;
            const catalog = { ...live, tables };
            expect(findDanglingReferences(catalog, data)).toEqual([]);
            const idMaps = buildIdMaps(tables, data);
            const idRewrite = new Map<string, string>();
            for (const map of idMaps.values())
              for (const [oldId, newId] of map) idRewrite.set(oldId, newId);
            for (const t of tables) {
              const columns = t.columns.filter((c) => !c.isGenerated);
              const transforms = buildRowTransforms(t, columns, {
                remap: true,
                sourceCompanyId,
                companyId,
                userId,
                targetGroupId: null,
                idMaps,
                idRewrite
              });
              for (const row of data[t.name]!) {
                await sql`INSERT INTO ${sql.id(t.name)} (${sql.join(columns.map((c) => sql.id(c.name)))})
              VALUES (${sql.join(columns.map((c: ColumnInfo, i: number) => sql`${bindValue(transforms[i]!(row[c.name]), c)}`))})`.execute(
                  trx
                );
              }
            }
            const restored = await trx
              .selectFrom("invoiceIntake")
              .selectAll()
              .where("companyId", "=", companyId)
              .executeTakeFirstOrThrow();
            expect(restored).toMatchObject({
              status: "NeedsReview",
              activeExtractionId: null,
              newSupplier: null,
              supplierId: idRewrite.get(supplier.id)
            });
            const source = await trx
              .selectFrom("invoiceIntakeSource")
              .selectAll()
              .where("companyId", "=", companyId)
              .executeTakeFirstOrThrow();
            expect(source.storagePath).toBe(
              rewriteStoragePath(path, sourceCompanyId, companyId, idRewrite)
            );
            expect(source.intakeId).toBe(restored.id);
            const extraction = await trx
              .selectFrom("documentExtraction")
              .selectAll()
              .where("companyId", "=", companyId)
              .executeTakeFirstOrThrow();
            expect(extraction).toMatchObject({
              intakeId: restored.id,
              sourceDocumentId: restored.id,
              status: "failed",
              claimToken: null,
              leaseUntil: null
            });
            expect(
              (
                await trx
                  .selectFrom("invoiceRecognitionRule")
                  .select("supplierId")
                  .where("companyId", "=", companyId)
                  .executeTakeFirstOrThrow()
              ).supplierId
            ).toBe(restored.supplierId);
            expect(
              await trx
                .selectFrom("invoiceIntakeSettings")
                .selectAll()
                .where("companyId", "=", companyId)
                .executeTakeFirstOrThrow()
            ).toMatchObject({
              enabled: false,
              automaticMercuryIntake: false,
              backfillStatus: "Idle",
              backfillUpperBound: null
            });
            throw rollback;
          })
        ).rejects.toBe(rollback);
      } finally {
        await db.destroy();
      }
    });
  }
);
