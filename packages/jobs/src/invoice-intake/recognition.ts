import { createHash } from "node:crypto";
import type { Kysely, KyselyDatabase, KyselyTx } from "@carbon/database/client";
import { sql } from "kysely";
import type { InvoiceActor, InvoiceItemType } from "./contracts";
import { invoiceItemTypes } from "./contracts";

export type InvoiceRecognitionLine = {
  lineKey: string;
  description: string | null;
  supplierSku: string | null;
  manufacturerPartNumber: string | null;
  purchaseUnit: string | null;
  packText?: string | null;
};
export function normalizeInvoiceIdentity(
  value: string | null | undefined
): string {
  // Do not remove punctuation, leading zeros, grade, dimension, or revision markers.
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
export function invoiceSupplierMatchKey(name: string) {
  return `supplier:${createHash("sha256").update(normalizeInvoiceIdentity(name)).digest("hex")}`;
}
export function invoiceItemMatchKey(line: InvoiceRecognitionLine) {
  // Bound the indexed key even for lengthy Unicode descriptions. Original
  // identities remain available in sourceText and immutable document evidence.
  return `item:${createHash("sha256")
    .update(
      JSON.stringify(
        [
          line.supplierSku,
          line.manufacturerPartNumber,
          line.description,
          line.purchaseUnit,
          line.packText
        ].map(normalizeInvoiceIdentity)
      )
    )
    .digest("hex")}`;
}
export type InvoiceCandidate = {
  id: string;
  name: string;
  readableId: string;
  type: InvoiceItemType;
  active: boolean;
  unitOfMeasureCode: string | null;
};
export type InvoiceLineRecognition = {
  lineKey: string;
  itemId: string | null;
  itemType: InvoiceItemType | null;
  purchaseUnit: string | null;
  stockUnit: string | null;
  conversionFactor: number | null;
  ruleId: string | null;
  supplierPartId: string | null;
  status: "matched" | "suggestion" | "conflict" | "unknown";
  reason: string;
  candidates: InvoiceCandidate[];
};
type SupplierPartCandidate = {
  id: string;
  itemId: string;
  supplierPartId: string | null;
  supplierUnitOfMeasureCode: string | null;
  conversionFactor: number;
  active: boolean;
};
type RuleCandidate = {
  id: string;
  matchKey: string;
  itemId: string | null;
  supplierPartId: string | null;
  purchaseUnit: string | null;
  stockUnit: string | null;
  conversionFactor: number | null;
};

/** Pure precedence resolver. Financial fields are deliberately absent from its contract. */
export function recognizeInvoiceLine(
  line: InvoiceRecognitionLine,
  input: {
    rules: RuleCandidate[];
    supplierParts: SupplierPartCandidate[];
    items: InvoiceCandidate[];
  }
): InvoiceLineRecognition {
  const base: InvoiceLineRecognition = {
    lineKey: line.lineKey,
    itemId: null,
    itemType: null,
    purchaseUnit: line.purchaseUnit,
    stockUnit: null,
    conversionFactor: null,
    ruleId: null,
    supplierPartId: null,
    status: "unknown",
    reason: "No confirmed identity",
    candidates: []
  };
  const items = new Map(
    input.items.filter((item) => item.active).map((item) => [item.id, item])
  );
  const selected = (
    itemId: string | null,
    purchaseUnit: string | null,
    factor: number | null,
    reason: string,
    ruleId: string | null,
    supplierPartId: string | null
  ): InvoiceLineRecognition => {
    const item = itemId ? items.get(itemId) : null;
    if (
      !item ||
      !purchaseUnit ||
      factor === null ||
      !Number.isFinite(Number(factor)) ||
      Number(factor) <= 0
    )
      return {
        ...base,
        status: "conflict",
        reason: "Saved identity or purchasing unit is unavailable"
      };
    return {
      ...base,
      itemId: item.id,
      itemType: item.type,
      purchaseUnit,
      stockUnit: item.unitOfMeasureCode,
      conversionFactor: Number(factor),
      reason,
      ruleId,
      supplierPartId,
      status: "matched",
      candidates: [item]
    };
  };
  const rules = input.rules.filter(
    (rule) => rule.matchKey === invoiceItemMatchKey(line)
  );
  if (rules.length > 1)
    return {
      ...base,
      status: "conflict",
      reason: "Several saved identities match"
    };
  const sku = normalizeInvoiceIdentity(line.supplierSku);
  const parts = sku
    ? input.supplierParts.filter(
        (part) =>
          part.active &&
          normalizeInvoiceIdentity(part.supplierPartId) === sku &&
          normalizeInvoiceIdentity(part.supplierUnitOfMeasureCode) ===
            normalizeInvoiceIdentity(line.purchaseUnit)
      )
    : [];
  const uniqueParts = new Map(
    parts.map((part) => [
      JSON.stringify([part.itemId, Number(part.conversionFactor)]),
      part
    ])
  );
  if (uniqueParts.size > 1)
    return {
      ...base,
      status: "conflict",
      reason: "Supplier SKU has conflicting item or pack mappings",
      candidates: parts.flatMap((part) =>
        items.get(part.itemId) ? [items.get(part.itemId)!] : []
      )
    };
  if (rules.length === 1) {
    const rule = rules[0]!;
    if (
      parts.some(
        (part) =>
          part.itemId !== rule.itemId ||
          Number(part.conversionFactor) !== Number(rule.conversionFactor)
      )
    )
      return {
        ...base,
        status: "conflict",
        reason: "Saved correction conflicts with Supplier Part"
      };
    const item = rule.itemId ? items.get(rule.itemId) : null;
    if (item && item.unitOfMeasureCode !== rule.stockUnit)
      return {
        ...base,
        status: "conflict",
        reason: "Saved inventory unit has changed"
      };
    return selected(
      rule.itemId,
      rule.purchaseUnit,
      rule.conversionFactor,
      "Confirmed supplier description and pack",
      rule.id,
      rule.supplierPartId
    );
  }
  // A new explicit pack description must be confirmed even when the SKU is familiar.
  if (uniqueParts.size === 1 && !line.packText?.trim()) {
    const part = [...uniqueParts.values()][0]!;
    return selected(
      part.itemId,
      part.supplierUnitOfMeasureCode,
      part.conversionFactor,
      "Confirmed Supplier Part SKU and purchase unit",
      null,
      part.id
    );
  }
  const exact = input.items.filter(
    (item) =>
      item.active &&
      [item.name, item.readableId].some((value) =>
        [line.description, line.supplierSku, line.manufacturerPartNumber].some(
          (evidence) =>
            evidence &&
            normalizeInvoiceIdentity(value) ===
              normalizeInvoiceIdentity(evidence)
        )
      )
  );
  const candidates = [
    ...new Map(
      [
        ...parts.flatMap((part) =>
          items.get(part.itemId) ? [items.get(part.itemId)!] : []
        ),
        ...exact
      ].map((item) => [item.id, item])
    ).values()
  ];
  return {
    ...base,
    candidates: candidates.slice(0, 20),
    status: candidates.length ? "suggestion" : "unknown",
    reason:
      line.packText && parts.length
        ? "Confirm the explicit pack description before reusing its conversion"
        : candidates.length > 1
          ? "Several exact catalog candidates; choose one"
          : candidates.length
            ? "Exact catalog candidate; confirm identity and units"
            : "No confirmed identity"
  };
}

export async function resolveInvoiceCandidates(
  db: Kysely<KyselyDatabase>,
  companyId: string,
  input: {
    supplierId?: string | null;
    supplierName?: string | null;
    mercuryRecipientId?: string | null;
    lines: InvoiceRecognitionLine[];
  }
) {
  const supplierKey = input.supplierName
    ? invoiceSupplierMatchKey(input.supplierName)
    : null;
  const [aliases, recipients, supplierCandidates] = await Promise.all([
    supplierKey
      ? db
          .selectFrom("invoiceRecognitionRule")
          .select(["supplierId"])
          .where("companyId", "=", companyId)
          .where("kind", "=", "supplierAlias")
          .where("active", "=", true)
          .where("matchKey", "=", supplierKey)
          .execute()
      : [],
    input.mercuryRecipientId
      ? db
          .selectFrom("mercuryRecipientMapping")
          .select("supplierId")
          .where("companyId", "=", companyId)
          .where("mercuryRecipientId", "=", input.mercuryRecipientId)
          .execute()
      : [],
    input.supplierName
      ? db
          .selectFrom("supplier")
          .select(["id", "name"])
          .where("companyId", "=", companyId)
          .where(
            sql<string>`lower(regexp_replace(trim(name), '\\s+', ' ', 'g'))`,
            "=",
            normalizeInvoiceIdentity(input.supplierName)
          )
          .limit(21)
          .execute()
      : []
  ]);
  const confirmed = [
    ...new Set([...aliases, ...recipients].map((row) => row.supplierId))
  ];
  const supplierId =
    input.supplierId ?? (confirmed.length === 1 ? confirmed[0] : null);
  const keys = [...new Set(input.lines.map(invoiceItemMatchKey))];
  const skus = [
    ...new Set(
      input.lines
        .map((line) => normalizeInvoiceIdentity(line.supplierSku))
        .filter(Boolean)
    )
  ];
  const evidence = [
    ...new Set(
      input.lines
        .flatMap((line) =>
          [line.description, line.supplierSku, line.manufacturerPartNumber].map(
            normalizeInvoiceIdentity
          )
        )
        .filter(Boolean)
    )
  ];
  const [rules, parts] = await Promise.all([
    supplierId && keys.length
      ? db
          .selectFrom("invoiceRecognitionRule")
          .selectAll()
          .where("companyId", "=", companyId)
          .where("supplierId", "=", supplierId)
          .where("kind", "=", "itemAlias")
          .where("active", "=", true)
          .where("matchKey", "in", keys)
          .execute()
      : [],
    supplierId && skus.length
      ? db
          .selectFrom("supplierPart")
          .select([
            "id",
            "itemId",
            "supplierPartId",
            "supplierUnitOfMeasureCode",
            "conversionFactor",
            "active"
          ])
          .where("companyId", "=", companyId)
          .where("supplierId", "=", supplierId)
          .where("active", "=", true)
          .where(
            sql<string>`lower(regexp_replace(trim("supplierPartId"), '\\s+', ' ', 'g'))`,
            "in",
            skus
          )
          .execute()
      : []
  ]);
  const ids = [
    ...new Set([
      ...rules.flatMap((rule) => (rule.itemId ? [rule.itemId] : [])),
      ...parts.map((part) => part.itemId)
    ])
  ];
  const items =
    evidence.length || ids.length
      ? await db
          .selectFrom("item")
          .select([
            "id",
            "name",
            "readableId",
            "type",
            "active",
            "unitOfMeasureCode"
          ])
          .where("companyId", "=", companyId)
          .where((eb) =>
            eb.or([
              ...(ids.length ? [eb("id", "in", ids)] : []),
              ...(evidence.length
                ? [
                    eb(
                      sql<string>`lower(regexp_replace(trim(name), '\\s+', ' ', 'g'))`,
                      "in",
                      evidence
                    ),
                    eb(sql<string>`lower("readableId")`, "in", evidence)
                  ]
                : [])
            ])
          )
          .limit(2001)
          .execute()
      : [];
  return {
    supplierId,
    supplierConflict:
      confirmed.length > 1 ||
      Boolean(
        input.supplierId && confirmed.some((id) => id !== input.supplierId)
      ),
    supplierCandidates,
    truncated: items.length > 2000 || supplierCandidates.length > 20,
    lines: input.lines.map((line) =>
      recognizeInvoiceLine(line, {
        rules,
        supplierParts: parts,
        items: items.filter((item): item is InvoiceCandidate =>
          invoiceItemTypes.some((type) => type === item.type)
        )
      })
    )
  };
}

export type InvoiceRecognitionDecision = InvoiceRecognitionLine & {
  rawDescription?: string | null;
  rawPurchaseUnit?: string | null;
  rawSupplierSku?: string | null;
  rawManufacturerPartNumber?: string | null;
  itemId: string;
  purchaseUnit: string;
  stockUnit: string;
  conversionFactor: number;
  remember: boolean;
  replaceRuleId?: string | null;
  replacementReason?: string | null;
};

export function invoiceRecognitionSource(
  decision: InvoiceRecognitionDecision
): InvoiceRecognitionLine {
  return {
    ...decision,
    description:
      decision.rawDescription !== undefined
        ? decision.rawDescription
        : decision.description,
    purchaseUnit:
      decision.rawPurchaseUnit !== undefined
        ? decision.rawPurchaseUnit
        : decision.purchaseUnit,
    supplierSku:
      decision.rawSupplierSku !== undefined
        ? decision.rawSupplierSku
        : decision.supplierSku,
    manufacturerPartNumber:
      decision.rawManufacturerPartNumber !== undefined
        ? decision.rawManufacturerPartNumber
        : decision.manufacturerPartNumber
  };
}

/** Called only inside the successful approval transaction, after permission/reference checks. */
export class InvoiceRecognitionError extends Error {}

export function prepareInvoiceRecognitionDecisions(
  lines: InvoiceRecognitionDecision[]
) {
  const decisions = new Map<string, InvoiceRecognitionDecision>();
  for (const line of lines.filter((line) => line.remember)) {
    const key = invoiceItemMatchKey(invoiceRecognitionSource(line));
    const prior = decisions.get(key);
    if (
      prior &&
      (prior.itemId !== line.itemId ||
        prior.purchaseUnit !== line.purchaseUnit ||
        prior.stockUnit !== line.stockUnit ||
        Number(prior.conversionFactor) !== Number(line.conversionFactor))
    ) {
      throw new InvoiceRecognitionError(
        "The same supplier item has conflicting remembered matches. Correct the item or pack conversion, or turn off Remember for the exception."
      );
    }
    decisions.set(key, line);
  }
  return [...decisions.entries()];
}

export async function persistInvoiceRecognition(
  trx: KyselyTx,
  actor: InvoiceActor,
  input: {
    intakeId: string;
    supplierId: string;
    supplierName: string | null;
    rememberSupplier: boolean;
    lines: InvoiceRecognitionDecision[];
  }
) {
  const decisions = prepareInvoiceRecognitionDecisions(input.lines);
  const keys = decisions.map(([key]) => key);
  const supplierKey =
    input.supplierName && input.rememberSupplier
      ? invoiceSupplierMatchKey(input.supplierName)
      : null;
  if (supplierKey) keys.push(supplierKey);
  if (!keys.length) return;
  const existing = await trx
    .selectFrom("invoiceRecognitionRule")
    .selectAll()
    .where("companyId", "=", actor.companyId)
    .where("active", "=", true)
    .where("matchKey", "in", keys)
    .forUpdate()
    .execute();
  const allParts = await trx
    .selectFrom("supplierPart")
    .selectAll()
    .where("companyId", "=", actor.companyId)
    .where("supplierId", "=", input.supplierId)
    .where("active", "=", true)
    .execute();
  if (supplierKey) {
    const saved = existing.find(
      (row) => row.kind === "supplierAlias" && row.matchKey === supplierKey
    );
    if (saved && saved.supplierId !== input.supplierId)
      throw new InvoiceRecognitionError(
        "Supplier alias conflicts with a confirmed supplier; disable or replace it explicitly"
      );
    if (!saved)
      await trx
        .insertInto("invoiceRecognitionRule")
        .values({
          companyId: actor.companyId,
          kind: "supplierAlias",
          matchKey: supplierKey,
          sourceText: input.supplierName!,
          supplierId: input.supplierId,
          intakeId: input.intakeId,
          createdBy: actor.userId
        })
        .execute();
  }
  for (const [key, decision] of decisions) {
    const saved = existing.find(
      (row) =>
        row.kind === "itemAlias" &&
        row.supplierId === input.supplierId &&
        row.matchKey === key
    );
    const matches = (row: {
      itemId: string | null;
      purchaseUnit: string | null;
      stockUnit: string | null;
      conversionFactor: number | null;
    }) =>
      row.itemId === decision.itemId &&
      row.purchaseUnit === decision.purchaseUnit &&
      row.stockUnit === decision.stockUnit &&
      Number(row.conversionFactor) === Number(decision.conversionFactor);
    const replacing = saved && !matches(saved);
    if (
      replacing &&
      (decision.replaceRuleId !== saved.id ||
        !decision.replacementReason?.trim())
    )
      throw new InvoiceRecognitionError(
        "Saved item identity conflicts; confirm replacement with a reason"
      );
    let supplierPartId: string | null = null;
    if (decision.supplierSku) {
      const parts = allParts.filter(
        (part) =>
          normalizeInvoiceIdentity(part.supplierPartId) ===
            normalizeInvoiceIdentity(decision.supplierSku) &&
          normalizeInvoiceIdentity(part.supplierUnitOfMeasureCode) ===
            normalizeInvoiceIdentity(decision.purchaseUnit)
      );
      const conflicts = parts.filter(
        (part) =>
          part.itemId !== decision.itemId ||
          Number(part.conversionFactor) !== Number(decision.conversionFactor)
      );
      if (conflicts.length && !replacing)
        throw new InvoiceRecognitionError(
          "Supplier Part conflicts with the reviewed item or conversion. Correct the Supplier Part in purchasing, replace its saved rule, or turn off Remember for this exception."
        );
      if (conflicts.length)
        await trx
          .updateTable("supplierPart")
          .set({
            active: false,
            updatedBy: actor.userId,
            updatedAt: sql`now()`
          })
          .where("companyId", "=", actor.companyId)
          .where(
            "id",
            "in",
            conflicts.map((part) => part.id)
          )
          .execute();
      supplierPartId =
        parts.find((part) => !conflicts.includes(part))?.id ?? null;
      if (!supplierPartId) {
        const part = await trx
          .insertInto("supplierPart")
          .values({
            companyId: actor.companyId,
            supplierId: input.supplierId,
            itemId: decision.itemId,
            supplierPartId: decision.supplierSku,
            supplierUnitOfMeasureCode: decision.purchaseUnit,
            conversionFactor: decision.conversionFactor,
            createdBy: actor.userId
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        supplierPartId = part.id;
        allParts.push(part);
      }
    }
    if (saved && matches(saved)) continue;
    if (replacing)
      await trx
        .updateTable("invoiceRecognitionRule")
        .set({ active: false, updatedBy: actor.userId, updatedAt: sql`now()` })
        .where("companyId", "=", actor.companyId)
        .where("id", "=", saved.id)
        .execute();
    await trx
      .insertInto("invoiceRecognitionRule")
      .values({
        companyId: actor.companyId,
        kind: "itemAlias",
        matchKey: key,
        sourceText: JSON.stringify({
          description: invoiceRecognitionSource(decision).description,
          sku: invoiceRecognitionSource(decision).supplierSku,
          pack: decision.packText ?? null,
          replacementReason: replacing ? decision.replacementReason : null
        }),
        supplierId: input.supplierId,
        itemId: decision.itemId,
        supplierPartId,
        purchaseUnit: decision.purchaseUnit,
        stockUnit: decision.stockUnit,
        conversionFactor: decision.conversionFactor,
        intakeId: input.intakeId,
        createdBy: actor.userId,
        supersedesId: saved?.id ?? null,
        version: (saved?.version ?? 0) + 1
      })
      .execute();
  }
}
