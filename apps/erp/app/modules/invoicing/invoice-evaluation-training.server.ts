/** Dev-only synthetic teaching through the same review/approval transactions as the UI. */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@carbon/database";
import type { KyselyDatabase } from "@carbon/database/client";
import type { InvoiceActor } from "@carbon/jobs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Kysely } from "kysely";
import type { InvoiceFixture } from "../../../../../packages/jobs/src/invoice-intake/fixtures/synthetic";
import { invoiceIntakeReviewValidator } from "./invoicing.models";
import {
  approveInvoiceIntake,
  getInvoiceIntakePermissions,
  getInvoiceIntakeReview,
  saveInvoiceIntakeReview
} from "./invoicing.server";

type Catalog = {
  locationId: string;
  suppliers: Map<string, string>;
  items: Map<string, string>;
};

/** Normal seed-company initializes identity, permissions and reference data; no external onboarding event is sent. */
export async function bootstrapInvoiceEvaluationCompany(
  db: Kysely<KyselyDatabase>,
  client: SupabaseClient<Database>,
  userId: string,
  runId: string,
  modelId: string
) {
  const employee = await db
    .selectFrom("employee as e")
    .innerJoin("user as u", "u.id", "e.id")
    .innerJoin("userPermission as p", "p.id", "e.id")
    .innerJoin("userToCompany as uc", (join) =>
      join
        .onRef("uc.userId", "=", "e.id")
        .onRef("uc.companyId", "=", "e.companyId")
    )
    .select(["e.companyId", "p.permissions"])
    .where("e.id", "=", userId)
    .where("e.active", "=", true)
    .where("u.active", "=", true)
    .where("uc.role", "=", "employee")
    .execute();
  if (
    !employee.some((row) => {
      const permissions = row.permissions as Record<string, unknown> | null;
      return (
        Array.isArray(permissions?.settings_create) &&
        permissions.settings_create.includes(row.companyId)
      );
    })
  )
    throw new Error(
      "An active operator with company settings creation permission is required"
    );
  const companyId = createHash("sha256")
    .update(`invoice-evaluation:${runId}:${modelId}`)
    .digest("hex")
    .slice(0, 24);
  const name = `Invoice Inference Evaluation ${modelId} ${runId.slice(0, 8)}`;
  const existing = await db
    .selectFrom("company")
    .select("name")
    .where("id", "=", companyId)
    .executeTakeFirst();
  if (existing && existing.name !== name)
    throw new Error("Synthetic evaluation identity is already used");
  if (!existing)
    await db
      .insertInto("company")
      .values({ id: companyId, name, baseCurrencyCode: "USD", timezone: "UTC" })
      .execute();
  const seed = await client.functions.invoke("seed-company", {
    body: { companyId, userId, identityOnly: false }
  });
  if (seed.error || seed.data?.success !== true)
    throw new Error("Native synthetic company initialization failed");
  const actor = { companyId, userId };
  await getInvoiceIntakePermissions(db, actor);
  const locationName = "Synthetic Evaluation Warehouse";
  let location = await db
    .selectFrom("location")
    .select("id")
    .where("companyId", "=", companyId)
    .where("name", "=", locationName)
    .executeTakeFirst();
  if (!location)
    location = await db
      .insertInto("location")
      .values({
        companyId,
        createdBy: userId,
        name: locationName,
        addressLine1: "1 Example Road",
        city: "Example",
        postalCode: "00000",
        timezone: "UTC"
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  await db
    .insertInto("employeeJob")
    .values({ companyId, id: userId, locationId: location.id })
    .onConflict((oc) =>
      oc
        .columns(["id", "companyId"])
        .doUpdateSet({ locationId: location!.id, updatedBy: userId })
    )
    .execute();
  return companyId;
}

/** All persistent setup is confined to an explicitly selected synthetic company. */
export async function prepareInvoiceEvaluationCatalog(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  fixtures: InvoiceFixture[]
): Promise<Catalog> {
  const permissions = await getInvoiceIntakePermissions(db, actor);
  if (
    !permissions.canUpdate ||
    !permissions.canApprove ||
    !permissions.canCreateSupplier ||
    permissions.canCreateItemTypes.length !== 5 ||
    !permissions.canSettings
  )
    throw new Error(
      "Synthetic evaluation requires invoice, supplier, item and settings permissions"
    );
  const company = await db
    .selectFrom("company")
    .select(["name", "baseCurrencyCode"])
    .where("id", "=", actor.companyId)
    .executeTakeFirstOrThrow();
  if (
    !company.name.startsWith("Invoice Inference Evaluation") ||
    company.baseCurrencyCode !== "USD"
  )
    throw new Error("Use an explicitly named USD synthetic evaluation company");
  const location = await db
    .selectFrom("employeeJob as j")
    .innerJoin("location as l", (join) =>
      join
        .onRef("l.id", "=", "j.locationId")
        .onRef("l.companyId", "=", "j.companyId")
    )
    .select("l.id")
    .where("j.companyId", "=", actor.companyId)
    .where("j.id", "=", actor.userId)
    .executeTakeFirst();
  if (!location)
    throw new Error(
      "Assign the evaluation employee a location in the test company first"
    );
  await db
    .insertInto("unitOfMeasure")
    .values(
      ["EA", "PACK", "SHEET", "SERVICE"].map((code) => ({
        companyId: actor.companyId,
        createdBy: actor.userId,
        code,
        name: code,
        active: true
      }))
    )
    .onConflict((oc) => oc.columns(["companyId", "code"]).doNothing())
    .execute();
  const training = fixtures.slice(0, 20);
  const supplierNames = [
    ...new Set(training.map((f) => f.labels.supplier.name.value!))
  ];
  const skus = [
    ...new Set(
      training.flatMap((f) => f.labels.lines.map((l) => l.supplierSku.value!))
    )
  ];
  const [suppliers, items] = await Promise.all([
    db
      .selectFrom("supplier")
      .select(["id", "name"])
      .where("companyId", "=", actor.companyId)
      .where("name", "in", supplierNames)
      .execute(),
    db
      .selectFrom("item")
      .select(["id", "readableId"])
      .where("companyId", "=", actor.companyId)
      .where(
        "readableId",
        "in",
        skus.map((sku) => `EVAL-${sku}`)
      )
      .execute()
  ]);
  if (
    new Set(suppliers.map((s) => s.name)).size !== suppliers.length ||
    new Set(items.map((i) => i.readableId)).size !== items.length
  )
    throw new Error(
      "Synthetic evaluation catalog contains ambiguous duplicate identities"
    );
  return {
    locationId: location.id,
    suppliers: new Map(suppliers.map((s) => [s.name, s.id])),
    items: new Map(items.map((i) => [i.readableId.replace(/^EVAL-/, ""), i.id]))
  };
}

export function expectedInvoiceRepeat(
  catalog: Catalog,
  fixture: InvoiceFixture
) {
  const supplierId = catalog.suppliers.get(fixture.labels.supplier.name.value!);
  const lines = fixture.labels.lines.map((line) => ({
    itemId: catalog.items.get(line.supplierSku.value!),
    purchaseUnit: line.purchaseUnit.value,
    stockUnit:
      line.purchaseUnit.value === "PACK" ? "EA" : line.purchaseUnit.value,
    conversionFactor: line.purchaseUnit.value === "PACK" ? "100" : "1"
  }));
  if (!supplierId || lines.some((line) => !line.itemId))
    throw new Error(
      "Complete synthetic training before measuring held-out repeat identities"
    );
  return { supplierId, lines };
}

/** Labels are the operator's explicit synthetic corrections; original provider evidence stays immutable. */
export async function teachInvoiceEvaluationFixture(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  intakeId: string,
  fixture: InvoiceFixture,
  catalog: Catalog
) {
  const number = Number(fixture.id.replace("synthetic-", ""));
  // Complex charge/FX examples remain quality probes; ordinary first-time receipts teach all three suppliers/five items.
  if (number > 20 || [11, 12, 13, 14, 15].includes(number)) return;
  const current = await getInvoiceIntakeReview(db, actor, intakeId);
  if (["Approved", "Linked"].includes(current.intake.status)) return;
  const source = fixture.labels,
    supplierName = source.supplier.name.value!;
  const supplierId = catalog.suppliers.get(supplierName) ?? null;
  const labels = Object.fromEntries(
    Object.entries(source.header).map(([key, field]) => [key, field.value])
  );
  const review = invoiceIntakeReviewValidator.parse({
    ...current.review,
    documentKind: source.documentKind,
    supplierId,
    newSupplier: supplierId
      ? null
      : { supplier: { name: supplierName, supplierStatus: "Active" } },
    locationId: catalog.locationId,
    header: {
      ...current.review.header,
      ...labels,
      exchangeRate: "1",
      sourceSupplierName: supplierName,
      noInvoiceNumberConfirmed: source.header.invoiceNumber.value === null,
      chargesConfirmed: true,
      rememberSupplier: true,
      resolvedSourceIssues: true,
      excludedLines: current.review.lines
        .slice(source.lines.length)
        .map((line) => ({
          lineKey: line.lineKey,
          reason: "Synthetic golden source has no corresponding additional line"
        }))
    },
    lines: source.lines.map((line, index) => {
      const sku = line.supplierSku.value!,
        itemId = catalog.items.get(sku) ?? null;
      const stockUnit =
        line.purchaseUnit.value === "PACK" ? "EA" : line.purchaseUnit.value;
      const type = line.suggestedType.value!;
      return {
        lineKey:
          current.review.lines[index]?.lineKey ?? `manual-golden-${index + 1}`,
        sortOrder: index,
        description: line.description.value,
        supplierSku: sku,
        manufacturerPartNumber: line.manufacturerPartNumber.value,
        quantity: line.quantity.value,
        supplierUnitPrice: line.unitPrice.value,
        discountAmount: line.discount.value,
        supplierTaxAmount: line.tax.value,
        taxPercent: line.taxPercent.value,
        supplierShippingCost: line.shipping.value,
        documentLineTotal: line.lineTotal.value,
        itemId,
        lineType: type,
        locationId: catalog.locationId,
        purchaseUnit: line.purchaseUnit.value,
        stockUnit,
        conversionFactor: line.purchaseUnit.value === "PACK" ? "100" : "1",
        newItem: itemId
          ? null
          : {
              type,
              data: {
                id: `EVAL-${sku}`,
                revision: "0",
                name: line.description.value,
                replenishmentSystem: "Buy",
                defaultMethodType:
                  type === "Service"
                    ? "Purchase to Order"
                    : "Pull from Inventory",
                itemTrackingType:
                  type === "Service" ? "Non-Inventory" : "Inventory",
                unitOfMeasureCode: stockUnit,
                unitCost: 1
              }
            },
        raw: current.review.lines[index]?.raw ?? {},
        review: { rememberMatch: true, origin: "manual" }
      };
    })
  });
  const saved = await saveInvoiceIntakeReview(db, actor, {
    id: intakeId,
    expectedRevision: current.intake.revision,
    review
  });
  if (!saved.validation.ready)
    throw new Error(
      "Synthetic teaching needs a valid canonical review before approval: " +
        saved.validation.issues
          .map((issue) => `${issue.path}:${issue.code}`)
          .join(", ")
    );
  await approveInvoiceIntake(db, actor, {
    intakeId,
    expectedRevision: saved.revision,
    approvalKey: randomUUID()
  });
  const approved = await getInvoiceIntakeReview(db, actor, intakeId);
  if (!approved.review.supplierId)
    throw new Error("Synthetic supplier approval did not resolve an identity");
  catalog.suppliers.set(supplierName, approved.review.supplierId);
  for (const [index, line] of approved.review.lines.entries()) {
    if (!line.itemId)
      throw new Error("Synthetic item approval did not resolve an identity");
    catalog.items.set(source.lines[index]!.supplierSku.value!, line.itemId);
  }
}
