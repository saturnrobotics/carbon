import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { EXTRACTION_CONFIDENCE_THRESHOLD } from "@carbon/env";
import { sql } from "kysely";
import { getJobDatabaseClient } from "../../../db";
import { inngest } from "../../client";
import { rfqExtractionSchema } from "./schemas";

function parseDateToISO8601(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const cleaned = value.trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }

  // YYYY-MM-DDTHH:mm:...
  if (/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) {
    return cleaned.slice(0, 10);
  }

  const parsed = Date.parse(cleaned);
  if (isNaN(parsed)) return null;

  // Only NON-ISO text reaches this fallback (ISO forms returned above), and
  // Date.parse interprets non-ISO date strings in the PROCESS timezone — so
  // reading the parts back with local getters is the symmetric round-trip
  // that preserves the document's written date under any TZ. UTC getters here
  // would shift "Jan 2, 2026" to Jan 1 west of UTC.
  const d = new Date(parsed);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const extractDocumentFunction = inngest.createFunction(
  { id: "extract-document", retries: 2 },
  { event: "carbon/extract-document" },
  async ({ event, step, logger }) => {
    const { documentExtractionId, companyId } = event.data;

    await step.run("extract-and-save", async () => {
      const client = getCarbonServiceRole();

      // 1. Fetch the extraction record
      const { data: extraction, error: fetchErr } = await client
        .from("documentExtraction")
        .select("*")
        .eq("id", documentExtractionId)
        .eq("companyId", companyId)
        .single();

      if (fetchErr || !extraction) {
        logger.error("Failed to fetch extraction record", { fetchErr });
        throw new Error("Extraction record not found");
      }

      // Financial documents exclusively use the persisted intake budget and
      // authorization checks. A legacy event must not bypass those controls.
      if (extraction.documentType === "purchaseInvoice") {
        return { state: "invoice_intake_required" };
      }
      const pieces = extraction.storagePath.split("/");
      if (
        extraction.intakeId ||
        extraction.sourceDocument !== "Request for Quote" ||
        pieces.length !== 3 ||
        pieces[0] !== companyId ||
        pieces[1] !== "extractions" ||
        !pieces[2] ||
        pieces[2] === "." ||
        pieces[2] === ".." ||
        Array.from(pieces[2]).some(
          (character) => character.charCodeAt(0) < 32 || character === "\\"
        )
      ) {
        throw new Error("rfq_extraction_source_invalid");
      }
      const access = await sql<{ allowed: boolean }>`SELECT EXISTS (
        SELECT 1 FROM public.employee e JOIN public."user" u ON u.id=e.id
        JOIN public."userToCompany" c ON c."userId"=e.id AND c."companyId"=e."companyId"
        JOIN public."userPermission" p ON p.id=e.id
        WHERE e."companyId"=${companyId} AND e.id=${extraction.createdBy} AND e.active AND u.active AND c.role='employee'
          AND (p.permissions->'sales_view' @> ${JSON.stringify([companyId])}::jsonb)
      ) AS allowed`.execute(getJobDatabaseClient(5));
      if (!access.rows[0]?.allowed)
        throw new Error("rfq_extraction_operator_unavailable");

      // 2. Update status to processing
      await client
        .from("documentExtraction")
        .update({
          status: "processing" as const,
          updatedAt: new Date().toISOString()
        })
        .eq("id", documentExtractionId)
        .eq("companyId", companyId);

      try {
        // 3. Download PDF from Supabase Storage
        const { data: fileData, error: downloadErr } = await client.storage
          .from("private")
          .download(extraction.storagePath);

        if (downloadErr || !fileData) {
          throw new Error(`Failed to download PDF: ${downloadErr?.message}`);
        }

        // 4. Extract text from PDF using pdfjs-dist
        const buffer = await fileData.arrayBuffer();
        const uint8Array = new Uint8Array(buffer);
        // @ts-ignore pdfjs-dist legacy build lacks type declarations
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        // Preload the worker: importing it self-registers globalThis.pdfjsWorker,
        // which pdfjs uses instead of importing pdf.worker.mjs by a runtime path.
        // That path isn't traceable by the serverless bundler, so the file is
        // absent in the Lambda bundle ("Setting up fake worker failed").
        // @ts-ignore no type declarations for the worker entry
        await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
        const pdf = await pdfjs.getDocument({ data: uint8Array }).promise;
        let pdfText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .map((item: any) => item.str)
            .join(" ");
          pdfText += `--- Page ${i} ---\n${pageText}\n\n`;
        }
        await pdf.destroy();

        // 5. Load candidate options so the AI can resolve extracted names to
        // real record ids itself (instead of the app fuzzy-matching afterward).
        // All lists are company-scoped; cap and log rather than silently truncate.
        const CANDIDATE_LIMIT = 1000;
        type Candidate = { id: string; name: string };
        const customerCandidates: Candidate[] = [];

        const collect = (
          rows: Candidate[] | null,
          into: Candidate[],
          label: string
        ) => {
          into.push(...(rows ?? []).slice(0, CANDIDATE_LIMIT));
          if ((rows?.length ?? 0) > CANDIDATE_LIMIT) {
            logger.warn(
              `${label} candidate list truncated to ${CANDIDATE_LIMIT} for company ${companyId}`
            );
          }
        };

        const { data: customers } = await client
          .from("customer")
          .select("id, name")
          .eq("companyId", companyId)
          .order("name")
          .limit(CANDIDATE_LIMIT + 1);
        collect(customers, customerCandidates, "Customer");
        const candidatesSection = `Known customers (choose the matching id for customerId, or null):\n${JSON.stringify(customerCandidates)}`;

        const matchingInstruction =
          " For the id fields, you are given lists of known records; return the id of the single best match, or null if none of the listed records clearly correspond to the document. Do NOT invent ids — only return an id that appears in the provided lists.";

        const systemPrompt =
          "You are an ERP data extraction assistant. Extract RFQ (Request for Quote) data from this PDF. For each field, provide the extracted value and a confidence score between 0.0 and 1.0. If a field is not found or you are unsure, set value to null and confidence to 0.0." +
          matchingInstruction;

        // 6. Call AI with structured output validated against the zod schema
        const { generateObject } = await import("ai");
        const { createOpenAI } = await import("@ai-sdk/openai");

        const aiApiKey =
          process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "mock-key";
        const aiBaseUrl = process.env.AI_BASE_URL;
        const aiModelName = process.env.AI_MODEL || "gpt-4o";

        const provider = createOpenAI({
          apiKey: aiApiKey,
          baseURL: aiBaseUrl,
          fetch: async (url, init) => {
            return fetch(url, {
              ...init,
              signal: AbortSignal.timeout(60_000)
            });
          }
        });

        const model = provider.chat(aiModelName);

        const prompt = `${systemPrompt}\n\nCandidate records to match against:\n${candidatesSection}\n\nHere is the text extracted from the PDF document:\n\n${pdfText}`;

        const { object: validated } = await generateObject({
          model,
          maxRetries: 5,
          schema: rfqExtractionSchema,
          prompt
        });

        // 7. Filter by confidence threshold
        const threshold = EXTRACTION_CONFIDENCE_THRESHOLD;
        const raw = validated as Record<string, unknown>;
        const filtered: Record<string, unknown> = {};
        const dateFields = [
          "invoiceDate",
          "dueDate",
          "rfqDate",
          "requestedDeliveryDate"
        ];

        for (const [key, val] of Object.entries(raw)) {
          if (key === "lineItems" && Array.isArray(val)) {
            filtered.lineItems = val.map((line: Record<string, unknown>) => {
              const filteredLine: Record<string, unknown> = {};
              for (const [lk, lv] of Object.entries(line)) {
                if (
                  lv &&
                  typeof lv === "object" &&
                  lv !== null &&
                  "confidence" in lv
                ) {
                  const field = lv as { value: unknown; confidence: number };
                  filteredLine[lk] =
                    field.confidence >= threshold ? field.value : null;
                }
              }
              return filteredLine;
            });
          } else if (
            val &&
            typeof val === "object" &&
            val !== null &&
            "confidence" in val
          ) {
            const field = val as { value: unknown; confidence: number };
            let extractedValue =
              field.confidence >= threshold ? field.value : null;
            if (extractedValue !== null && dateFields.includes(key)) {
              extractedValue =
                parseDateToISO8601(extractedValue) ?? extractedValue;
            }
            filtered[key] = extractedValue;
          }
        }

        // 8. Save results
        await client
          .from("documentExtraction")
          .update({
            status: "completed" as const,
            extractedData: raw as any,
            filteredData: filtered as any,
            updatedAt: new Date().toISOString()
          })
          .eq("id", documentExtractionId)
          .eq("companyId", companyId);
      } catch (err) {
        logger.error("Extraction failed", { err });
        await client
          .from("documentExtraction")
          .update({
            status: "failed" as const,
            error: err instanceof Error ? err.message : String(err),
            updatedAt: new Date().toISOString()
          })
          .eq("id", documentExtractionId)
          .eq("companyId", companyId);
        throw err;
      }
    });
  }
);
