import type { Json } from "@carbon/database";
import type { KyselyTx } from "@carbon/database/client";
import { sql } from "kysely";
import type { z } from "zod";
import {
  type ReviewedMasterActor,
  validateReviewedCustomFields
} from "~/modules/items/items.server";
import {
  supplierContactValidator,
  supplierLocationValidator,
  supplierTaxValidator,
  supplierValidator
} from "./purchasing.models";
import { prepareCreatedSupplier } from "./purchasing.service";

export type ReviewedSupplierInput = {
  supplier: Omit<z.input<typeof supplierValidator>, "id">;
  customFields?: Json;
  contact?: Record<string, unknown>;
  address?: Record<string, unknown>;
  tax?: Record<string, unknown>;
};

/** Caller authorizes purchasing_create; all native interceptors run in this transaction. */
export async function createReviewedSupplier(
  trx: KyselyTx,
  actor: ReviewedMasterActor,
  input: ReviewedSupplierInput
) {
  const { id: _ignoredId, ...supplier } = supplierValidator.parse(
    input.supplier
  );
  const contact = input.contact
    ? supplierContactValidator.parse(input.contact)
    : undefined;
  const address = input.address
    ? supplierLocationValidator.parse(input.address)
    : undefined;
  // A new supplier cannot claim another supplier's contact or address link.
  if (
    supplier.purchasingContactId ||
    contact?.supplierLocationId ||
    contact?.id ||
    contact?.contactId ||
    address?.id ||
    address?.addressId
  ) {
    throw new Error(
      "New supplier details must not reference existing supplier links"
    );
  }
  const company = await trx
    .selectFrom("company")
    .select("baseCurrencyCode")
    .where("id", "=", actor.companyId)
    .executeTakeFirstOrThrow();
  const definitions = await trx
    .selectFrom("customField")
    .select(["id", "table", "dataTypeId", "required", "tags", "listOptions"])
    .where("companyId", "=", actor.companyId)
    .where("table", "=", "supplier")
    .where("active", "=", true)
    .execute();
  const requested = validateReviewedCustomFields(
    definitions,
    "supplier",
    input.customFields
  ).map((ref) => ({ kind: String(ref.kind), id: ref.id }));
  if (supplier.accountManagerId)
    requested.push({ kind: "employee", id: supplier.accountManagerId });
  if (supplier.supplierTypeId)
    requested.push({ kind: "supplierType", id: supplier.supplierTypeId });
  if (supplier.currencyCode)
    requested.push({ kind: "currency", id: supplier.currencyCode });
  if (address?.countryCode)
    requested.push({ kind: "country", id: address.countryCode });
  if (requested.length) {
    const found = await sql<{ kind: string; id: string }>`
      WITH requested(kind,id) AS (VALUES ${sql.join(requested.map((ref) => sql`(${ref.kind}::text,${ref.id}::text)`))}),
      available(kind,id) AS (
        SELECT 'employee',id FROM "employee" WHERE "companyId"=${actor.companyId} AND active
        UNION ALL SELECT 'user',"userId" FROM "userToCompany" WHERE "companyId"=${actor.companyId}
        UNION ALL SELECT 'supplierType',id FROM "supplierType" WHERE "companyId"=${actor.companyId}
        UNION ALL SELECT 'supplier',id FROM "supplier" WHERE "companyId"=${actor.companyId}
        UNION ALL SELECT 'customer',id FROM "customer" WHERE "companyId"=${actor.companyId}
        UNION ALL SELECT 'currency',code FROM "currencyCode"
        UNION ALL SELECT 'country',alpha2 FROM "country"
      ) SELECT DISTINCT a.* FROM available a JOIN requested r USING(kind,id)
    `.execute(trx);
    const keys = new Set(found.rows.map((ref) => `${ref.kind}:${ref.id}`));
    if (requested.some((ref) => !keys.has(`${ref.kind}:${ref.id}`))) {
      throw new Error("A supplier reference is unavailable in this company");
    }
  }
  const approvalRule = await trx
    .selectFrom("approvalRule")
    .select("id")
    .where("companyId", "=", actor.companyId)
    .where("documentType", "=", "supplier")
    .where("enabled", "=", true)
    .where("lowerBoundAmount", "=", 0)
    .executeTakeFirst();
  // Receipt approval never grants supplier-approval authority.
  const supplierStatus = approvalRule
    ? "Pending"
    : (supplier.supplierStatus ?? "Active");
  const created = await trx
    .insertInto("supplier")
    .values(
      prepareCreatedSupplier({
        ...supplier,
        companyId: actor.companyId,
        createdBy: actor.userId,
        currencyCode:
          supplier.currencyCode ?? company.baseCurrencyCode ?? undefined,
        supplierStatus,
        customFields: input.customFields
      })
    )
    .returning(["id", "supplierStatus", "readableId"])
    .executeTakeFirstOrThrow();
  let supplierLocationId: string | undefined;
  if (address) {
    const { id: _id, addressId: _addressId, name, ...fields } = address;
    const stored = await trx
      .insertInto("address")
      .values({ ...fields, companyId: actor.companyId })
      .returning("id")
      .executeTakeFirstOrThrow();
    const link = await trx
      .insertInto("supplierLocation")
      .values({
        supplierId: created.id,
        addressId: stored.id,
        name,
        companyId: actor.companyId
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    supplierLocationId = link.id;
  }
  let supplierContactId: string | undefined;
  if (contact) {
    const {
      id: _id,
      contactId: _contactId,
      supplierLocationId: _locationId,
      ...fields
    } = contact;
    const stored = await trx
      .insertInto("contact")
      .values({ ...fields, companyId: actor.companyId, isCustomer: false })
      .returning("id")
      .executeTakeFirstOrThrow();
    const link = await trx
      .insertInto("supplierContact")
      .values({
        supplierId: created.id,
        contactId: stored.id,
        supplierLocationId,
        companyId: actor.companyId
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    supplierContactId = link.id;
    await trx
      .updateTable("supplier")
      .set({
        purchasingContactId: link.id,
        updatedBy: actor.userId,
        updatedAt: sql<string>`now()`
      })
      .where("id", "=", created.id)
      .where("companyId", "=", actor.companyId)
      .execute();
  }
  if (input.tax) {
    const { supplierId: _supplierId, ...tax } = supplierTaxValidator.parse({
      ...input.tax,
      supplierId: created.id
    });
    await trx
      .updateTable("supplierTax")
      .set(tax)
      .where("supplierId", "=", created.id)
      .where("companyId", "=", actor.companyId)
      .execute();
  }
  return {
    supplierId: created.id,
    supplierContactId,
    supplierLocationId,
    supplierStatus: created.supplierStatus,
    readableId: created.readableId
  };
}
