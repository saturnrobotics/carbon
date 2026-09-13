import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  type DatabasePrincipal,
  withKnowledgeTransaction
} from "../database.server";
import {
  calibrateConfidence,
  DEFAULT_EXTRACTION_SOURCE_KIND,
  type ExtractionSourceKind,
  isExtractionSourceKind,
  requiresReviewerConfirmation
} from "./confidence";
import {
  type Evidence,
  EXTRACTION_CONTRACT_VERSION,
  type Extraction,
  MEASUREMENT_LIMIT,
  measurementNamePattern,
  measurementUnresolvedName,
  PROPOSED_FIELD_NAMES,
  type ProposedFields,
  proposedFieldsSchema,
  proposedMeasurementFieldSchema
} from "./contracts";

export type ParserOutput = {
  fields: Record<string, unknown>;
  evidence: Record<string, Evidence[]>;
  /** Typed proposals; untrusted until normalized and recalibrated here. */
  proposed?: unknown;
  /** How the parser read the document; unknown kinds get the least trusted prior. */
  sourceKind?: unknown;
  warnings?: string[];
};

function proposalWarning(name: string, reason: string): string {
  return `Parser proposal "${name.slice(0, 64)}" was discarded: ${reason}`;
}

/**
 * Validates each typed proposal on its own so one malformed field costs only
 * that field, then replaces the parser's claimed score with the calibrated
 * one. A proposal below the review threshold is unresolved, exactly like a
 * field with no evidence.
 */
function normalizeProposed(
  raw: unknown,
  sourceKind: ExtractionSourceKind,
  warnings: string[]
): { proposed: ProposedFields; unresolved: string[] } {
  const proposed: ProposedFields = {};
  const unresolved: string[] = [];
  if (raw === undefined || raw === null) return { proposed, unresolved };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(
      "Parser proposed fields were not an object and were discarded"
    );
    return { proposed, unresolved };
  }
  const calibrate = <T extends { confidence: number; evidence: unknown[] }>(
    field: T
  ): T => ({
    ...field,
    confidence: calibrateConfidence(
      field.confidence,
      field.evidence.length,
      sourceKind
    )
  });
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (name === "measurements") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        warnings.push(proposalWarning(name, "measurements must be an object"));
        continue;
      }
      const measurements: NonNullable<ProposedFields["measurements"]> = {};
      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>
      ).slice(0, MEASUREMENT_LIMIT)) {
        const parsed = proposedMeasurementFieldSchema.safeParse(entry);
        const unresolvedName = measurementUnresolvedName(key);
        if (!parsed.success || !measurementNamePattern.test(key)) {
          warnings.push(proposalWarning(unresolvedName, "invalid measurement"));
          continue;
        }
        const measurement = calibrate(parsed.data);
        measurements[key] = measurement;
        if (requiresReviewerConfirmation(measurement.confidence))
          unresolved.push(unresolvedName);
      }
      if (Object.keys(measurements).length)
        proposed.measurements = measurements;
      continue;
    }
    const known = PROPOSED_FIELD_NAMES.find((candidate) => candidate === name);
    if (!known) {
      warnings.push(proposalWarning(name, "not a typed field"));
      continue;
    }
    const parsed = proposedFieldsSchema.shape[known].safeParse(value);
    if (!parsed.success || !parsed.data) {
      warnings.push(proposalWarning(known, "invalid proposal"));
      continue;
    }
    const field = calibrate(parsed.data);
    // Each name has its own schema; the parse above already proved the member.
    (proposed as Record<string, unknown>)[known] = field;
    if (requiresReviewerConfirmation(field.confidence)) unresolved.push(known);
  }
  return { proposed, unresolved };
}

/** Normalizes untrusted parser output without allowing it to declare readiness. */
export function createExtraction(output: ParserOutput): Extraction {
  const evidence = Object.fromEntries(
    Object.entries(output.evidence)
      .slice(0, 500)
      .map(([field, entries]) => [
        field,
        entries
          .slice(0, 100)
          .filter(
            (entry) =>
              Number.isInteger(entry.page) &&
              entry.page > 0 &&
              entry.page <= 2_000 &&
              entry.text.length <= 8_000
          )
      ])
  );
  const fields = Object.fromEntries(
    Object.entries(output.fields).slice(0, 500)
  );
  const warnings = [...(output.warnings ?? [])];
  const sourceKind = isExtractionSourceKind(output.sourceKind)
    ? output.sourceKind
    : DEFAULT_EXTRACTION_SOURCE_KIND;
  const { proposed, unresolved: lowConfidence } = normalizeProposed(
    output.proposed,
    sourceKind,
    warnings
  );
  const unresolved = [
    ...new Set([
      ...Object.keys(fields).filter((field) => !evidence[field]?.length),
      ...lowConfidence
    ])
  ].sort();
  const extraction: Extraction = {
    contractVersion: EXTRACTION_CONTRACT_VERSION,
    fields,
    proposed,
    evidence,
    unresolved,
    warnings: [...new Set(warnings)].slice(0, 100)
  };
  if (Buffer.byteLength(JSON.stringify(fields), "utf8") > 60_000)
    throw new Error("parser fields exceed the immutable intake byte limit");
  if (Buffer.byteLength(JSON.stringify(extraction), "utf8") > 1_000_000)
    throw new Error(
      "parser output exceeds the immutable extraction byte limit"
    );
  return extraction;
}

export function extractionFingerprint(input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)])
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}

export async function getCapturedIntakeForExtraction(
  pool: Pool,
  principal: DatabasePrincipal,
  intakeId: string
) {
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<{
      id: string;
      generation: string;
      version: string;
      state: string;
      inputRefs: unknown;
      reviewDecisions: unknown;
      extraction: unknown;
    }>(
      `SELECT id,generation,version,state,"inputRefs","reviewDecisions",extraction FROM knowledge.intake WHERE "companyId"=$1 AND id=$2`,
      [principal.companyId, intakeId]
    );
    if (!result.rows[0])
      throw new Error("captured intake is unavailable to this worker");
    return result.rows[0];
  });
}

export async function attachCapturedObject(
  pool: Pool,
  principal: DatabasePrincipal,
  input: {
    intakeId: string;
    createdBy: string;
    expectedVersion: string;
    object: unknown;
  }
) {
  await withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const result = await client.query(
      `UPDATE knowledge.intake SET "inputRefs"="inputRefs" || $4::jsonb,"updatedBy"=$2,"updatedAt"=now(),version=version+1
       WHERE "companyId"=$1 AND id=$3 AND version=$5 AND state IN ('captured','extracting')`,
      [
        principal.companyId,
        input.createdBy,
        input.intakeId,
        JSON.stringify([input.object]),
        input.expectedVersion
      ]
    );
    if (result.rowCount !== 1)
      throw new Error("intake changed before acquisition committed");
  });
}

export async function persistExtractionGeneration(
  pool: Pool,
  principal: DatabasePrincipal,
  input: {
    intakeId: string;
    generation: string;
    expectedGeneration: string;
    createdBy: string;
    providerProfile: string;
    sourceVersions: unknown;
    extraction: Extraction;
  }
) {
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const existing = await client.query<{ output: Extraction }>(
      `SELECT output FROM knowledge.extraction WHERE "companyId"=$1 AND "intakeId"=$2 AND generation=$3`,
      [principal.companyId, input.intakeId, input.generation]
    );
    if (existing.rows[0]) {
      if (
        extractionFingerprint(existing.rows[0].output) !==
        extractionFingerprint(input.extraction)
      )
        throw new Error(
          "extraction generation already contains different immutable output"
        );
      return;
    }
    await client.query(
      `INSERT INTO knowledge.extraction ("companyId","createdBy","intakeId",generation,"providerProfile","sourceVersions",output,status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'complete')`,
      [
        principal.companyId,
        input.createdBy,
        input.intakeId,
        input.generation,
        input.providerProfile,
        JSON.stringify(input.sourceVersions),
        JSON.stringify(input.extraction)
      ]
    );
    const updated = await client.query<{ id: string }>(
      `UPDATE knowledge.intake SET generation=$3, extraction=$4::jsonb, unresolved=$5::jsonb, state='needs-review', "updatedBy"=$2, "updatedAt"=now(),version=version+1
       WHERE id=$1 AND "companyId"=$6 AND generation=$7 RETURNING id`,
      [
        input.intakeId,
        input.createdBy,
        input.generation,
        JSON.stringify(input.extraction.fields),
        JSON.stringify(input.extraction.unresolved),
        principal.companyId,
        input.expectedGeneration
      ]
    );
    if (!updated.rows[0])
      throw new Error(
        "intake generation changed; re-read before storing extraction"
      );
  });
}

export async function markReviewedIntakeReady(
  pool: Pool,
  principal: DatabasePrincipal & { actorId: string },
  intakeId: string,
  expectedGeneration: string,
  expectedVersion: string,
  decisions: unknown
) {
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE knowledge.intake SET "reviewDecisions"=$4::jsonb,state='ready',"updatedBy"=$2,"updatedAt"=now(),version=version+1
       WHERE id=$1 AND "companyId"=$3 AND generation=$5 AND version=$6 AND jsonb_array_length(unresolved)=0 RETURNING id`,
      [
        intakeId,
        principal.actorId,
        principal.companyId,
        JSON.stringify(decisions),
        expectedGeneration,
        expectedVersion
      ]
    );
    if (!result.rows[0])
      throw new Error(
        "intake cannot publish until unresolved fields are acknowledged"
      );
  });
}
