import { sql } from "kysely";
import type { JobDatabase } from "../db";
export type InvoiceIntakeValidationContext = {
  db: JobDatabase;
  companyId: string;
  intakeId: string;
  userId: string;
  generation: number;
  expectedRevision: number;
  attemptId: string;
};
export type InvoiceIntakeValidationResult = {
  validated: boolean;
  revision?: number;
};
type Validator = (
  context: InvoiceIntakeValidationContext
) => Promise<InvoiceIntakeValidationResult>;
let validator: Validator | undefined;

/** The ERP installs its canonical native validation, like workflow dispatch. */
export function setInvoiceIntakeValidation(handler: Validator | undefined) {
  validator = handler;
}
export async function validateInvoiceIntake(
  context: InvoiceIntakeValidationContext
) {
  // Standalone workers without an ERP validator fail closed to NeedsReview.
  if (!validator) return false;
  const result = await validator(context);
  if (!result.validated) return false;
  await sql`UPDATE public."documentExtraction" SET "filteredData"=coalesce("filteredData",'{}'::jsonb)||jsonb_build_object('validationRevision',${result.revision ?? context.expectedRevision}::int)
    WHERE "companyId"=${context.companyId} AND "intakeId"=${context.intakeId} AND id=${context.attemptId}
      AND generation=${context.generation} AND status='completed'`.execute(
    context.db
  );
  return true;
}
export async function pendingInvoiceValidations(db: JobDatabase) {
  return (
    await sql<
      Omit<InvoiceIntakeValidationContext, "db">
    >`SELECT i."companyId",i.id AS "intakeId",i.generation,i.revision AS "expectedRevision",
    e.id AS "attemptId",e."createdBy" AS "userId" FROM public."invoiceIntake" i
    JOIN public."documentExtraction" e ON e.id=i."activeExtractionId" AND e."companyId"=i."companyId" AND e."intakeId"=i.id AND e.generation=i.generation
    WHERE i.status='NeedsReview' AND e.status='completed' AND i.revision=e."inputRevision"+1
      AND (e."filteredData"->>'validationRevision') IS DISTINCT FROM i.revision::text
    ORDER BY i."updatedAt",i.id LIMIT 100`.execute(db)
  ).rows;
}
