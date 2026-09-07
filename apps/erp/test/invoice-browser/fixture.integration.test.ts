import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getPostgresConnectionPool } from "@carbon/database/client";
import { createClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { expect, it } from "vitest";
import {
	approveInvoiceIntake,
	getInvoiceIntakeReview,
	validateHydratedInvoiceIntake,
} from "../../../../apps/erp/app/modules/invoicing/invoicing.server";
import { bootstrap } from "../../../../packages/database/src/datasets/bootstrap";
import { getJobDatabaseClient } from "../../../../packages/jobs/src/db";
import { copyInvoiceAttachments } from "../../../../packages/jobs/src/invoice-intake/attachments";
import { registerMercuryInvoiceSources } from "../../../../packages/jobs/src/invoice-intake/backfill";
import { emptyInvoiceExtraction } from "../../../../packages/jobs/src/invoice-intake/contracts";
import { registerInvoiceSource } from "../../../../packages/jobs/src/invoice-intake/ingestion";
import {
	createGoogleInvoiceProvider,
	loadInvoiceProviderConfig,
} from "../../../../packages/jobs/src/invoice-intake/provider";
import { setInvoiceIntakeValidation } from "../../../../packages/jobs/src/invoice-intake/validation";
import { runInvoiceIntake } from "../../../../packages/jobs/src/invoice-intake/worker";
import { storeAttachment } from "../../../../packages/jobs/src/payment-sync/sync";

it("prepares and verifies an isolated Mercury browser acceptance", async () => {
	for (const key of ["SUPABASE_URL", "ERP_URL"]) {
		expect(["localhost", "127.0.0.1"]).toContain(
			new URL(process.env[key]!).hostname,
		);
	}
	expect(["localhost", "127.0.0.1"]).toContain(
		new URL(process.env.SUPABASE_DB_URL!).hostname,
	);
	expect(process.env.MERCURY_API_TOKEN || "").toBe("");
	expect(process.env.GMAIL_ACCOUNTS_JSON || "").toBe("");
	const db = getJobDatabaseClient(5),
		dir = process.env.INVOICE_BROWSER_DIRECTORY!;
	const email = process.env.INVOICE_BROWSER_EMAIL!;
	expect(email).toMatch(/^invoice-browser-[a-f0-9-]+@example\.com$/);
	const phase = process.env.INVOICE_BROWSER_PHASE || "seed";
	let actor: { companyId: string; userId: string };
	if (phase === "bootstrap") {
		expect(
			await db
				.selectFrom("user")
				.select("id")
				.where("email", "=", email)
				.executeTakeFirst(),
		).toBeUndefined();
		const client = await getPostgresConnectionPool(5).connect();
		try {
			actor = await bootstrap(client, email);
		} finally {
			client.release();
		}
		await db
			.insertInto("invoiceIntakeSettings")
			.values({
				companyId: actor.companyId,
				createdBy: actor.userId,
				updatedBy: actor.userId,
				enabled: false,
				dailyBudgetUsd: 10,
				monthlyBudgetUsd: 100,
			})
			.onConflict((oc) => oc.column("companyId").doNothing())
			.execute();
		for (const [kind, lines] of Object.entries({
			deferred: [
				"Deferred Gmail candidate",
				"Evidence reserved for later review",
			],
			stub: [
				"Mercury payment confirmation",
				"Transfer only; no invoice line items",
			],
			receipt: [
				"Mercury Browser Example Supplies",
				"RECEIPT",
				"Browser sample fasteners 3 EA x USD 14.00 = USD 42.00",
				"Total USD 42.00",
			],
		})) {
			const pdf = await PDFDocument.create();
			const page = pdf.addPage([612, 792]);
			const font = await pdf.embedFont(StandardFonts.Helvetica);
			lines.forEach((line, index) =>
				page.drawText(line, { x: 48, y: 740 - index * 32, size: 14, font }),
			);
			writeFileSync(
				dir + "/mercury-browser-" + kind + ".pdf",
				await pdf.save(),
				{ mode: 0o600 },
			);
		}
		writeFileSync(dir + "/actor.json", JSON.stringify({ actor, email }), {
			mode: 0o600,
		});
		await db.destroy();
		return;
	}
	actor = JSON.parse(readFileSync(dir + "/actor.json", "utf8")).actor;
	const storage = createClient(
		process.env.SUPABASE_URL!,
		process.env.SUPABASE_SERVICE_ROLE_KEY!,
		{ auth: { persistSession: false } },
	).storage;
	const context = { db, storage, ...actor };
	const tableNames = [
		"supplier",
		"item",
		"purchaseInvoice",
		"purchaseInvoiceLine",
		"itemLedger",
		"costLedger",
		"receipt",
		"journal",
		"journalLine",
		"payment",
		"supplierLedger",
	];
	async function counts() {
		const result = await sql<{ name: string; n: string }>`${sql.join(
			tableNames.map(
				(table) =>
					sql`SELECT ${table}::text name,count(*)::text n FROM public.${sql.id(table)} WHERE "companyId"=${actor.companyId}`,
			),
			sql` UNION ALL `,
		)}`.execute(db);
		return Object.fromEntries(
			result.rows.map((row) => [row.name, Number(row.n)]),
		);
	}
	const field = <T extends string | null>(value: T) => ({
		value,
		confidence: value === null ? null : 1,
		sourceText: value,
		page: value === null ? null : 1,
	});
	let paid = 0;
	function provider(invoiceNumber: string) {
		const extraction = emptyInvoiceExtraction();
		extraction.documentKind = "receipt";
		extraction.supplier.name = field("Mercury Browser Example Supplies");
		extraction.supplier.email = field("receipts@example.com");
		extraction.supplier.addressLine1 = field("100 Example Street");
		extraction.supplier.city = field("Example City");
		for (const [key, value] of Object.entries({
			invoiceNumber,
			issueDate: "2026-09-07",
			currencyCode: "USD",
			subtotal: "42",
			discount: "0",
			shipping: "0",
			tax: "0",
			total: "42",
		}))
			extraction.header[key as keyof typeof extraction.header] = field(value);
		extraction.lines = [
			{
				lineKey: "mercury-browser-line",
				page: 1,
				sourceText: "Browser sample fasteners 3 EA x USD 14.00 = USD 42.00",
				description: field("Browser sample fasteners"),
				supplierSku: field("EXAMPLE-FASTENER"),
				manufacturerPartNumber: field(null),
				quantity: field("3"),
				purchaseUnit: field("EA"),
				packText: field(null),
				unitPrice: field("14"),
				discount: field("0"),
				tax: field("0"),
				taxPercent: field("0"),
				shipping: field("0"),
				lineTotal: field("42"),
				suggestedType: field("Consumable"),
			},
		];
		if (process.env.INVOICE_BROWSER_PHASE === "process_reparse") {
			extraction.header.invoiceNumber = field("PARSED-CHANGED-REFERENCE");
			extraction.lines[0].description = field(
				"New parsed fastener description",
			);
			extraction.lines.push({
				...structuredClone(extraction.lines[0]),
				lineKey: "new-source-line",
				description: field("Newly parsed source charge"),
				quantity: field("1"),
				unitPrice: field("5"),
				lineTotal: field("5"),
			});
			extraction.header.total = field("47");
			extraction.header.subtotal = field("47");
		}
		return createGoogleInvoiceProvider(
			loadInvoiceProviderConfig({
				INVOICE_INTAKE_ENABLED: "true",
				INVOICE_AI_PROJECT: "synthetic-browser-project",
				INVOICE_AI_PRICE_VERIFIED_AT: "2026-09-06",
				INVOICE_AI_INPUT_PRICE_USD_PER_MILLION: "1.65",
				INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION: "9.9",
			}),
			{
				fetch: async (url) => {
					if (String(url).includes("metadata.google.internal"))
						return Response.json({
							access_token: "synthetic-local",
							token_type: "Bearer",
							expires_in: 3600,
						});
					if (String(url).endsWith(":countTokens"))
						return Response.json({ totalTokens: 1000 });
					paid++;
					return Response.json({
						candidates: [
							{
								finishReason: "STOP",
								content: { parts: [{ text: JSON.stringify(extraction) }] },
							},
						],
						usageMetadata: {
							promptTokenCount: 1000,
							candidatesTokenCount: 200,
							thoughtsTokenCount: 20,
							totalTokenCount: 1220,
						},
						modelVersion: "synthetic-local",
					});
				},
			},
		);
	}
	const settings = await db
		.selectFrom("invoiceIntakeSettings")
		.select("enabled")
		.where("companyId", "=", actor.companyId)
		.executeTakeFirstOrThrow();
	try {
		setInvoiceIntakeValidation(validateHydratedInvoiceIntake);
		if (phase === "seed") {
			const run = randomUUID().slice(0, 8),
				cases: Record<string, any> = {};
			const baseline = await counts();
			for (const kind of [
				"missing",
				"unsupported",
				"receipt",
				"multiple",
				"legacy_primary",
			]) {
				const transactionId = "browser-mercury-" + run + "-" + kind;
				const files = [];
				const gmail = await storeAttachment(
					{ storage, companyId: actor.companyId },
					transactionId,
					"deferred-gmail.pdf",
					new Uint8Array(
						Buffer.concat([
							readFileSync(dir + "/mercury-browser-deferred.pdf"),
							Buffer.from("\n% " + run + " " + kind),
						]),
					),
					{
						source: "gmail",
						mailbox: email,
						messageId: "synthetic-" + run + "-" + kind,
					},
				);
				files.push(gmail);
				if (kind === "multiple")
					files.push(
						await storeAttachment(
							{ storage, companyId: actor.companyId },
							transactionId,
							"mercury-payment-confirmation.pdf",
							new Uint8Array(readFileSync(dir + "/mercury-browser-stub.pdf")),
							{ source: "mercury" },
						),
					);
				if (
					kind === "receipt" ||
					kind === "multiple" ||
					kind === "legacy_primary"
				)
					files.push(
						await storeAttachment(
							{ storage, companyId: actor.companyId },
							transactionId,
							"mercury-receipt-" + kind + ".pdf",
							new Uint8Array(
								Buffer.concat([
									readFileSync(dir + "/mercury-browser-receipt.pdf"),
									Buffer.from("\n% " + run + " " + kind),
								]),
							),
							{ source: "mercury" },
						),
					);
				const row = await db
					.insertInto("mercuryTransactionImport")
					.values({
						companyId: actor.companyId,
						createdBy: actor.userId,
						mercuryTransactionId: transactionId,
						mercuryAccountId: "synthetic-browser-account",
						remoteStatus: "sent",
						amount: 42,
						currencyCode: "USD",
						transactionDate: "2026-09-07T12:00:00Z",
						reference: "MERCURY-BROWSER-" + run + "-" + kind,
						memo: "Synthetic purchase payment for browser acceptance",
						vendorSuggestion: JSON.stringify({
							name: "Mercury Browser Example Supplies",
							email: "receipts@example.com",
							source: "Mercury recipient",
							reason: "Synthetic fixture",
							mercuryReceiptAcquisition: {
								attachmentCount:
									kind === "unsupported"
										? 1
										: files.filter((f) => f.source === "mercury").length,
								hasGeneratedReceipt: kind === "unsupported",
								checkedAt: "2026-09-07T17:00:00Z",
								attachments:
									kind === "unsupported"
										? [
												{
													id: "synthetic-xlsx",
													fileName: "unsupported-invoice.xlsx",
													status: "unsupported",
													errorCode: "attachment_unsupported_file",
												},
											]
										: files
												.filter((f) => f.source === "mercury")
												.map((f, i) => ({
													id: "synthetic-receipt-" + i,
													fileName: f.fileName,
													status: "saved",
													path: f.path,
												})),
							},
						}),
						attachments: JSON.stringify(files),
						invoiceEvidence: JSON.stringify([
							{
								mailbox: email,
								messageId: "synthetic-" + run + "-" + kind,
								subject: "Deferred synthetic email invoice",
								from: "receipts@example.com",
								date: "2026-09-07T12:00:00Z",
								score: 75,
								reasons: ["Synthetic candidate only"],
							},
						]),
					})
					.returning("id")
					.executeTakeFirstOrThrow();
				const registered = await registerMercuryInvoiceSources(context, row.id);
				// Retain a legacy Gmail provenance row as well; it must stay ineligible.
				await registerInvoiceSource(db, storage, actor, {
					kind: "gmail",
					sourceKey: "legacy-browser-" + run + "-" + kind,
					mercuryImportId: row.id,
					storagePath: gmail.path,
				});
				const intake = await db
					.selectFrom("invoiceIntake")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("id", "=", registered.intakeId)
					.executeTakeFirstOrThrow();
				if (kind === "legacy_primary")
					await db
						.updateTable("invoiceIntake")
						.set({
							header: JSON.stringify({
								...(intake.header as object),
								primarySourceSha256: gmail.path
									.split("/")
									.at(-1)!
									.split(".")[0],
							}),
						})
						.where("companyId", "=", actor.companyId)
						.where("id", "=", intake.id)
						.execute();
				cases[kind] = {
					importId: row.id,
					intakeId: intake.id,
					invoiceNumber: "MB-" + run + "-" + kind,
					url: process.env.ERP_URL + "/x/invoicing/documents/" + intake.id,
				};
			}
			await db
				.updateTable("invoiceIntakeSettings")
				.set({ enabled: true })
				.where("companyId", "=", actor.companyId)
				.execute();
			for (const kind of [
				"missing",
				"unsupported",
				"receipt",
				"multiple",
				"legacy_primary",
			]) {
				const row = await db
					.selectFrom("invoiceIntake")
					.select(["generation"])
					.where("companyId", "=", actor.companyId)
					.where("id", "=", cases[kind].intakeId)
					.executeTakeFirstOrThrow();
				const result = await runInvoiceIntake({
					db,
					storage,
					companyId: actor.companyId,
					intakeId: cases[kind].intakeId,
					generation: row.generation,
					provider: provider(cases[kind].invoiceNumber),
				});
				const review = await getInvoiceIntakeReview(
					db,
					actor,
					cases[kind].intakeId,
				);
				cases[kind].initialStatus = review.intake.status;
				cases[kind].initialLines = review.review.lines.length;
				cases[kind].workerState = result.state;
			}
			expect(cases.receipt.initialLines).toBe(1);
			expect(cases.missing.initialLines).toBe(0);
			expect(cases.multiple.initialLines).toBe(0);
			expect(paid).toBe(1);
			expect(await counts()).toEqual(baseline);
			writeFileSync(
				dir + "/invoice-browser-state.json",
				JSON.stringify(
					{ actor, email, run, baseline, cases, paidCalls: paid },
					null,
					2,
				),
				{ mode: 0o600 },
			);
			console.log(
				"Synthetic Mercury browser cases prepared; only one fake extraction, no financial changes.",
			);
		} else {
			const state = JSON.parse(
				readFileSync(dir + "/invoice-browser-state.json", "utf8"),
			);
			expect(state.actor).toEqual(actor);
			if (phase === "process_reparse") {
				const target = state.cases.receipt;
				const row = await db
					.selectFrom("invoiceIntake")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("id", "=", target.intakeId)
					.executeTakeFirstOrThrow();
				await db
					.updateTable("invoiceIntakeSettings")
					.set({ enabled: true })
					.where("companyId", "=", actor.companyId)
					.execute();
				const result = await runInvoiceIntake({
					db,
					storage,
					companyId: actor.companyId,
					intakeId: row.id,
					generation: row.generation,
					provider: provider(target.invoiceNumber),
				});
				const review = await getInvoiceIntakeReview(db, actor, row.id);
				expect(review.review.header.invoiceNumber).toBe("OPERATOR-CORRECTED");
				expect(review.review.lines[0].description).toBe(
					"Operator corrected item description",
				);
				expect(review.pendingExtractionReviewId).toBeTruthy();
				expect(review.extraction?.lines).toHaveLength(2);
				console.log(
					"Real worker preserved saved corrections and retained two new extraction lines; pending acknowledgement verified.",
				);
			} else if (phase === "add_unreadable" || phase === "change_evidence") {
				const row = await db
					.selectFrom("mercuryTransactionImport")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("id", "=", state.cases.receipt.importId)
					.executeTakeFirstOrThrow();
				const suggestion =
					typeof row.vendorSuggestion === "string"
						? JSON.parse(row.vendorSuggestion)
						: row.vendorSuggestion;
				const acquisition = suggestion.mercuryReceiptAcquisition;
				acquisition.attachments = acquisition.attachments.filter(
					(a: { id: string }) => a.id !== "unreadable-synthetic",
				);
				acquisition.attachments.push({
					id: "unreadable-synthetic",
					fileName: "supporting-source.xlsx",
					status: phase === "add_unreadable" ? "unsupported" : "unavailable",
					errorCode:
						phase === "add_unreadable"
							? "attachment_unsupported_file"
							: "attachment_unavailable",
				});
				acquisition.attachmentCount = acquisition.attachments.length;
				await db
					.updateTable("mercuryTransactionImport")
					.set({
						vendorSuggestion: JSON.stringify(suggestion),
						amount: phase === "add_unreadable" ? 45 : 46,
					})
					.where("companyId", "=", actor.companyId)
					.where("id", "=", row.id)
					.execute();
				console.log(
					"Synthetic unreadable attachment and payment evidence prepared.",
				);
			} else if (phase === "verify_preservation") {
				expect(await counts()).toEqual(state.baseline);
				const target = await getInvoiceIntakeReview(
					db,
					actor,
					state.cases.receipt.intakeId,
				);
				expect(target.review.header.invoiceNumber).toBe("OPERATOR-CORRECTED");
				expect(target.review.lines[0].description).toBe(
					"Operator corrected item description",
				);
				expect(target.review.header.total).toBe("43");
				expect(target.pendingExtractionReviewId).toBeNull();
				expect(target.review.header.excludedLines).toHaveLength(1);
				expect(target.review.header.receiptAcknowledgements).toHaveLength(1);
				expect(target.review.header.paymentReviewFingerprint).toBe(
					target.paymentEvidenceFingerprint,
				);
				writeFileSync(
					dir + "/invoice-browser-verification.json",
					JSON.stringify(
						{
							savedHeaderPreserved: true,
							savedLinePreserved: true,
							newExtractionAcknowledged: true,
							newSourceLineExplicitlyExcluded: true,
							currentReceiptReason: true,
							currentPaymentReason: true,
							financialTableChanges: 0,
							ledgerChanges: 0,
						},
						null,
						2,
					),
					{ mode: 0o600 },
				);
				console.log(
					"Preservation/evidence database state verified; no supplier, item, invoice, financial-line, payment or ledger changes.",
				);
			} else if (phase === "archive_original") {
				const previous = JSON.parse(
					readFileSync(dir + "/approved.json", "utf8"),
				);
				const previousIntake = await db
					.selectFrom("invoiceIntake")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("id", "=", previous.cases.receipt.intakeId)
					.executeTakeFirstOrThrow();
				expect(previousIntake.status).toBe("Approved");
				const sources = await db
					.selectFrom("invoiceIntakeSource")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("intakeId", "=", previousIntake.id)
					.where("kind", "=", "mercury")
					.where("sha256", "is not", null)
					.execute();
				expect(sources.length).toBeGreaterThan(0);
				for (const source of sources)
					await db
						.updateTable("invoiceIntakeSource")
						.set({
							provenance: JSON.stringify({
								...(source.provenance as object),
								current: false,
							}),
						})
						.where("companyId", "=", actor.companyId)
						.where("id", "=", source.id)
						.execute();
				state.cases.archived = previous.cases.receipt;
				writeFileSync(
					dir + "/invoice-browser-state.json",
					JSON.stringify(state),
					{ mode: 0o600 },
				);
				console.log(
					"Archived only the original of an existing synthetic Approved review for read-only preview verification.",
				);
			} else if (phase === "link_draft") {
				const previous = JSON.parse(
					readFileSync(dir + "/approved.json", "utf8"),
				);
				const previousIntake = await db
					.selectFrom("invoiceIntake")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("id", "=", previous.cases.receipt.intakeId)
					.executeTakeFirstOrThrow();
				expect(previousIntake.purchaseInvoiceId).toBeTruthy();
				const invoice = await db
					.selectFrom("purchaseInvoice")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("id", "=", previousIntake.purchaseInvoiceId)
					.executeTakeFirstOrThrow();
				expect(invoice.status).toBe("Draft");
				const target = state.cases.multiple;
				const row = await db
					.selectFrom("invoiceIntake")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("id", "=", target.intakeId)
					.executeTakeFirstOrThrow();
				await db
					.updateTable("invoiceIntake")
					.set({
						purchaseInvoiceId: invoice.id,
						header: JSON.stringify({
							...(row.header as object),
							expectedInvoiceUpdatedAt: invoice.updatedAt,
							mergeMode: "merge",
						}),
					})
					.where("companyId", "=", actor.companyId)
					.where("id", "=", row.id)
					.execute();
				console.log(
					"Synthetic existing Draft linked for unmapped-line browser warning.",
				);
			} else if (phase === "process_multiple") {
				await db
					.updateTable("invoiceIntakeSettings")
					.set({ enabled: true })
					.where("companyId", "=", actor.companyId)
					.execute();
				const row = await db
					.selectFrom("invoiceIntake")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("id", "=", state.cases.multiple.intakeId)
					.executeTakeFirstOrThrow();
				await runInvoiceIntake({
					db,
					storage,
					companyId: actor.companyId,
					intakeId: row.id,
					generation: row.generation,
					provider: provider(state.cases.multiple.invoiceNumber),
				});
				const review = await getInvoiceIntakeReview(db, actor, row.id);
				expect(review.review.lines.length).toBe(1);
				expect(paid).toBe(1);
				console.log("Selected Mercury source parsed with one fake extraction.");
			} else if (phase === "verify") {
				const row = await db
					.selectFrom("invoiceIntake")
					.selectAll()
					.where("companyId", "=", actor.companyId)
					.where("id", "=", state.cases.receipt.intakeId)
					.executeTakeFirstOrThrow();
				expect(row.status).toBe("Approved");
				expect(row.purchaseInvoiceId).toBeTruthy();
				const invoice = await db
					.selectFrom("purchaseInvoice")
					.select(["status"])
					.where("companyId", "=", actor.companyId)
					.where("id", "=", row.purchaseInvoiceId!)
					.executeTakeFirstOrThrow();
				expect(invoice.status).toBe("Draft");
				const nativeLines = await db
					.selectFrom("purchaseInvoiceLine")
					.select([
						"quantity",
						"supplierUnitPrice",
						"supplierTaxAmount",
						"supplierShippingCost",
						"invoiceLineType",
					])
					.where("companyId", "=", actor.companyId)
					.where("invoiceId", "=", row.purchaseInvoiceId!)
					.execute();
				expect(nativeLines).toHaveLength(1);
				expect(Number(nativeLines[0]!.quantity)).toBe(3);
				expect(Number(nativeLines[0]!.supplierUnitPrice)).toBe(14);
				expect(Number(nativeLines[0]!.supplierTaxAmount)).toBe(0);
				expect(Number(nativeLines[0]!.supplierShippingCost)).toBe(0);
				expect(nativeLines[0]!.invoiceLineType).toBe("Consumable");
				const before = await counts();
				expect(before.supplier - state.baseline.supplier).toBe(1);
				expect(before.item - state.baseline.item).toBe(1);
				expect(before.purchaseInvoice - state.baseline.purchaseInvoice).toBe(1);
				expect(
					before.purchaseInvoiceLine - state.baseline.purchaseInvoiceLine,
				).toBe(1);
				for (const table of tableNames.slice(4))
					expect(before[table], table).toBe(state.baseline[table]);
				await approveInvoiceIntake(db, actor, {
					intakeId: row.id,
					expectedRevision: row.revision,
					approvalKey: row.approvalKey!,
				});
				await registerMercuryInvoiceSources(
					context,
					state.cases.receipt.importId,
				);
				expect(await counts()).toEqual(before);
				const copy = await copyInvoiceAttachments({
					db,
					storage,
					companyId: actor.companyId,
					intakeId: row.id,
				});
				expect(copy.state).toBe("complete");
				const documents = await db
					.selectFrom("document")
					.select(["name", "path"])
					.where("companyId", "=", actor.companyId)
					.where("sourceDocument", "=", "Purchase Invoice")
					.where("sourceDocumentId", "=", row.purchaseInvoiceId!)
					.execute();
				expect(documents).toHaveLength(1);
				expect(documents[0]!.name).toBe("mercury-receipt-receipt.pdf");
				expect(await counts()).toEqual(before);
				writeFileSync(
					dir + "/invoice-browser-verification.json",
					JSON.stringify(
						{
							draft: true,
							newSupplier: 1,
							newItem: 1,
							newInvoice: 1,
							newLine: 1,
							ledgerChanges: 0,
							idempotent: true,
							nativeQuantity: 3,
							nativeUnitPrice: 14,
							receiptCopied: 1,
							gmailCopied: 0,
						},
						null,
						2,
					),
					{ mode: 0o600 },
				);
				console.log(
					"Synthetic Draft, supplier/item creation and replay idempotency verified; no ledger side effects.",
				);
			} else throw Error("Unsupported phase");
		}
	} finally {
		await db
			.updateTable("invoiceIntakeSettings")
			.set({ enabled: settings.enabled })
			.where("companyId", "=", actor.companyId)
			.execute();
		await db.destroy();
	}
});
