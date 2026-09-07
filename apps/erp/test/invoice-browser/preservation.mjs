import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

if (!process.env.INVOICE_BROWSER_DIRECTORY)
	throw Error("INVOICE_BROWSER_DIRECTORY is required");
process.umask(0o077);
const dir = process.env.INVOICE_BROWSER_DIRECTORY + "/";
const state = JSON.parse(
	readFileSync(dir + "invoice-browser-state.json", "utf8"),
);
const phase = process.argv[2] || "review";
for (const item of Object.values(state.cases))
	if (!["localhost", "127.0.0.1"].includes(new URL(item.url).hostname))
		throw Error("Local browser cases required");
const context = await chromium.launchPersistentContext(
	dir + "playwright-profile",
	{
		headless: true,
		executablePath: process.env.INVOICE_BROWSER_EXECUTABLE || undefined,
		viewport: { width: 1920, height: 1400 },
	},
);
context.setDefaultTimeout(30000);
context.setDefaultNavigationTimeout(120000);
const page = context.pages()[0] || (await context.newPage());
const failures = [];
page.on("pageerror", (error) => failures.push(String(error)));
const results = [];
function assert(condition, message) {
	if (!condition) throw Error(message);
}
async function reactHydrated(locator, handler) {
	const deadline = performance.now() + 30000;
	while (performance.now() < deadline) {
		await locator.waitFor({ state: "visible" });
		const ready = await locator.evaluate((element, requiredHandler) => {
			if (!element.isConnected) return false;
			const key = Object.keys(element).find((key) =>
				key.startsWith("__reactProps$"),
			);
			if (!key) return false;
			return (
				!requiredHandler ||
				typeof element[key]?.[requiredHandler] === "function"
			);
		}, handler);
		if (ready) return;
		await page.waitForTimeout(50);
	}
	throw Error("React event handlers did not become ready before interaction");
}
async function settled() {
	await page.waitForLoadState("domcontentloaded");
	if (page.url().includes("/login")) {
		await reactHydrated(
			page.getByLabel("Email Address", { exact: true }),
			"onChange",
		);
	} else if (
		/^\/x\/invoicing\/documents\/[^/]+$/.test(new URL(page.url()).pathname)
	) {
		await reactHydrated(
			page.getByLabel("Invoice number", { exact: true }),
			"onChange",
		);
	} else {
		await reactHydrated(page.locator("button").first());
	}
	await page.waitForTimeout(1600);
}
async function visit(kind) {
	await page.goto(state.cases[kind].url);
	await settled();
	if (page.url().includes("/login")) {
		await page.getByLabel("Email Address", { exact: true }).fill(state.email);
		await page
			.getByRole("button", { name: "Continue", exact: true })
			.evaluate((b) => b.closest("form").requestSubmit(b));
		await page.waitForURL("**/x**");
		await page.goto(state.cases[kind].url);
		await settled();
	}
	assert(
		(await page
			.getByRole("heading", { name: "Review invoice document", exact: true })
			.count()) === 1,
		"Review route failed to render",
	);
}
async function fill(label, value) {
	const input = page.getByLabel(label, { exact: true });
	await reactHydrated(input, "onChange");
	await input.fill(value);
	await input.blur();
}
async function combo(label, option) {
	await page.getByRole("combobox", { name: label, exact: true }).click();
	await page.getByRole("option", { name: option, exact: true }).last().click();
	await page.waitForTimeout(300);
}
async function postAction(buttonName, action) {
	const button = page.getByRole("button", { name: buttonName, exact: true });
	await reactHydrated(button, "onClick");
	const intakeId = new URL(page.url()).pathname.split("/").at(-1);
	const actionPath = `/api/invoice-intake/${intakeId}/action`;
	await button.focus();
	const [response] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname.replace(/\.data$/, "") ===
					actionPath &&
				response.request().postDataJSON()?.action === action,
		),
		button.press("Enter"),
	]);
	assert(
		response.ok(),
		`${buttonName} POST failed with HTTP ${response.status()}`,
	);
	await response.finished();
	await settled();
	const alerts = await page.locator("[role=alert]").allTextContents();
	assert(!alerts.length, buttonName + " failed: " + alerts.join(";"));
}
async function editableReviewIdle() {
	await page.waitForFunction(() => {
		const button = [...document.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Save review",
		);
		return button && !button.disabled;
	});
}
async function save() {
	await postAction("Save review", "save");
	await editableReviewIdle();
}
async function parseAgain() {
	await postAction("Parse again", "retry");
	await page
		.getByText(/^(Queued|Processing)$/i)
		.first()
		.waitFor({ state: "visible" });
	await editableReviewIdle();
}
async function screenshot(name) {
	const path = dir + "preservation-browser-" + name + ".png";
	writeFileSync(path, await page.screenshot({ fullPage: true }), {
		mode: 0o600,
	});
	chmodSync(path, 0o600);
}
async function value(label, expected) {
	assert(
		(await page.getByLabel(label, { exact: true }).inputValue()) === expected,
		"Unexpected " + label,
	);
}
try {
	if (phase === "initial") {
		await page.goto(
			new URL("/x/invoicing/documents", state.cases.missing.url).href,
		);
		await settled();
		if (page.url().includes("/login")) {
			await visit("missing");
			await page.goto(
				new URL("/x/invoicing/documents", state.cases.missing.url).href,
			);
			await settled();
		}
		assert(
			(await page
				.getByRole("link", { name: "Actionable", exact: true })
				.count()) === 1,
			"Default actionable tab absent",
		);
		assert(
			(await page
				.locator(
					'a[href="/x/invoicing/documents/' +
						state.cases.missing.intakeId +
						'"]',
				)
				.count()) === 0,
			"NeedsDocument leaked into actionable inbox",
		);
		assert(
			(await page
				.locator(
					'a[href="/x/invoicing/documents/' +
						state.cases.receipt.intakeId +
						'"]',
				)
				.count()) === 1,
			"NeedsReview missing from actionable inbox",
		);
		await page
			.getByRole("link", { name: "Needs document", exact: true })
			.click();
		await settled();
		const row = page.locator("tr").filter({
			has: page.locator(
				'a[href="/x/invoicing/documents/' + state.cases.missing.intakeId + '"]',
			),
		});
		const rowText = await row.innerText();
		assert(
			rowText.includes("Payment:") &&
				rowText.includes("42") &&
				rowText.includes("Mercury Browser Example Supplies"),
			"Missing document row lacks explicit bank fallback",
		);
		await page.getByRole("link", { name: "All", exact: true }).click();
		await settled();
		assert(
			new URL(page.url()).searchParams.get("status") === "All",
			"All filter has wrong URL",
		);
		results.push(
			"Actionable default excludes missing receipts; explicit NeedsDocument shows labeled bank payee, reference, date and amount; All is explicit",
		);
		await visit("receipt");
		await fill("Invoice number", "OPERATOR-CORRECTED");
		await fill("Description", "Operator corrected item description");
		await fill(
			"Review reason for supporting-source.xlsx",
			"Supporting fee schedule only; all purchase lines are on the readable receipt.",
		);
		await fill(
			"Explain the payment difference, status, or allocation",
			"The bank amount includes a separately reconciled transfer fee.",
		);
		await save();
		await page.reload();
		await settled();
		await value("Invoice number", "OPERATOR-CORRECTED");
		await value("Description", "Operator corrected item description");
		await value(
			"Review reason for supporting-source.xlsx",
			"Supporting fee schedule only; all purchase lines are on the readable receipt.",
		);
		await parseAgain();
		results.push(
			"Native review saves corrected header/line and attachment/payment explanations before Parse again",
		);
	} else if (phase === "queue") {
		await visit("receipt");
		await parseAgain();
		results.push("Queued repeat extraction");
	} else if (phase === "preserved") {
		await visit("receipt");
		await value("Invoice number", "OPERATOR-CORRECTED");
		await value("Description", "Operator corrected item description");
		assert(
			(await page.locator("body").innerText()).includes(
				"PARSED-CHANGED-REFERENCE",
			),
			"New raw parsed reference is not visible beside saved correction",
		);
		assert(
			(await page.locator("body").innerText()).includes(
				"Newly parsed source charge",
			),
			"New source line hidden",
		);
		const ack = page.getByLabel(
			"I reviewed the new extraction against my saved corrections",
			{ exact: true },
		);
		assert(!(await ack.isChecked()), "New extraction auto-acknowledged");
		await save();
		await page.reload();
		await settled();
		assert(
			!(await ack.isChecked()),
			"Save implicitly acknowledged new extraction",
		);
		if (await page.getByLabel("Exclusion reason", { exact: true }).count())
			await page
				.getByLabel("Exclusion reason", { exact: true })
				.fill(
					"This is the separately documented transfer fee, not another inventory line.",
				);
		if (
			await page
				.getByRole("button", { name: "Exclude source line", exact: true })
				.count()
		)
			await page
				.getByRole("button", { name: "Exclude source line", exact: true })
				.click();
		await ack.check();
		await save();
		await page.reload();
		await settled();
		assert(
			(await ack.count()) === 0,
			"Acknowledged extraction remains pending after save",
		);
		await value("Description", "Operator corrected item description");
		await page
			.locator("summary")
			.filter({ hasText: "Excluded source lines" })
			.click();
		assert(
			(await page.locator("body").innerText()).includes(
				"This is the separately documented transfer fee, not another inventory line.",
			),
			"Explicit source exclusion did not persist",
		);
		results.push(
			"Real worker reparse preserves corrections; new facts visible; Save alone does not acknowledge; explicit source exclusion and acknowledgement persist",
		);
	} else if (phase === "stale") {
		await visit("receipt");
		await value("Review reason for supporting-source.xlsx", "");
		assert(
			(await page
				.getByRole("button", { name: "Confirm explanation", exact: true })
				.count()) === 1,
			"Changed bank evidence did not request reconfirmation",
		);
		assert(
			await page
				.getByRole("button", { name: "Approve and create draft", exact: true })
				.isDisabled(),
			"Stale evidence can approve",
		);
		await fill(
			"Review reason for supporting-source.xlsx",
			"The supporting fee schedule remains separate; the original invoice contains all purchase lines.",
		);
		await page
			.getByRole("button", { name: "Confirm explanation", exact: true })
			.click();
		await save();
		await page.reload();
		await settled();
		assert(
			(await page
				.getByRole("button", { name: "Confirm explanation", exact: true })
				.count()) === 0,
			"Current evidence confirmation did not persist",
		);
		await value(
			"Review reason for supporting-source.xlsx",
			"The supporting fee schedule remains separate; the original invoice contains all purchase lines.",
		);
		results.push(
			"Changed attachment fingerprint clears visible reason; changed payment requires explicit confirmation; corrected evidence persists",
		);
	} else if (phase === "archived") {
		await visit("archived");
		const preview = page.getByRole("combobox", {
			name: "Preview document",
			exact: true,
		});
		assert(
			(await preview.innerText()).includes("Archived"),
			"Historical original is not identified as archived",
		);
		const original = await page
			.getByRole("link", { name: "Open original document", exact: true })
			.getAttribute("href");
		assert(original, "Archived approved original has no download");
		assert(
			["localhost", "127.0.0.1"].includes(new URL(original).hostname),
			"Local signed document URL required",
		);
		const response = await context.request.get(original);
		assert(response.ok(), "Archived approved original is unavailable");
		assert(
			(await response.body()).subarray(0, 5).toString() === "%PDF-",
			"Archived source does not return expected PDF bytes",
		);
		assert(
			await page
				.getByRole("button", { name: "Approve and create draft", exact: true })
				.isDisabled(),
			"Terminal archived review allows approval",
		);
		results.push(
			"Approved archived original remains readable through signed PDF preview and is visibly historical",
		);
	} else if (phase === "edited_total") {
		await visit("receipt");
		await fill("Source document total", "43");
		assert(
			(await page.locator("body").innerText()).includes(
				"Save the edited invoice total or currency",
			),
			"Edited total does not require saving new explanation basis",
		);
		assert(
			await page
				.getByRole("button", { name: "Confirm explanation", exact: true })
				.isDisabled(),
			"Unsaved new invoice basis can reconfirm old fingerprint",
		);
		await save();
		await page.reload();
		await settled();
		assert(
			!(await page
				.getByRole("button", { name: "Confirm explanation", exact: true })
				.isDisabled()),
			"Saved amount cannot confirm current evidence",
		);
		await page
			.getByRole("button", { name: "Confirm explanation", exact: true })
			.click();
		await save();
		await page.reload();
		await settled();
		assert(
			(await page
				.getByRole("button", { name: "Confirm explanation", exact: true })
				.count()) === 0,
			"Updated invoice-basis confirmation did not persist",
		);
		results.push(
			"Editing invoice amount invalidates old explanation, requires save then explicit confirmation",
		);
	} else if (phase === "merge") {
		await visit("multiple");
		await combo("Review action", "Merge explicitly selected draft lines");
		await save();
		const body = await page.locator("body").innerText();
		assert(
			body.includes("Map every existing draft financial line before merging."),
			"Missing final Draft merge coverage notice",
		);
		assert(
			body.includes("Browser sample fasteners"),
			"Unmapped native financial line name missing",
		);
		assert(
			await page
				.getByRole("button", { name: "Approve and create draft", exact: true })
				.isDisabled(),
			"Unmapped final financial line can approve",
		);
		results.push(
			"Existing Draft merge names unmapped financial line and disables approval",
		);
	} else throw Error("Unsupported preservation phase");
	assert(
		failures.length === 0,
		"Browser runtime errors: " + failures.join(";"),
	);
	writeFileSync(
		dir + "preservation-browser-" + phase + "-results.json",
		JSON.stringify({ passed: true, results }, null, 2),
		{ mode: 0o600 },
	);
	await screenshot(phase);
	console.log(JSON.stringify({ passed: true, results }));
} catch (error) {
	writeFileSync(
		dir + "preservation-browser-error.txt",
		await page
			.locator("body")
			.innerText()
			.catch(() => ""),
		{ mode: 0o600 },
	);
	await screenshot("error").catch(() => {});
	console.error(String(error));
	process.exitCode = 1;
} finally {
	await context.close();
}
