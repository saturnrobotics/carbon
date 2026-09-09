import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

if (!process.env.INVOICE_BROWSER_DIRECTORY)
  throw Error("INVOICE_BROWSER_DIRECTORY is required");
process.umask(0o077);
const dir = process.env.INVOICE_BROWSER_DIRECTORY + "/";
const state = JSON.parse(
  readFileSync(dir + "invoice-browser-state.json", "utf8")
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
    viewport: { width: 1920, height: 1400 }
  }
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
        key.startsWith("__reactProps$")
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
      "onChange"
    );
  } else if (
    /^\/x\/invoicing\/documents\/[^/]+$/.test(new URL(page.url()).pathname)
  ) {
    await reactHydrated(
      page.getByLabel("Invoice number", { exact: true }),
      "onChange"
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
    "Review route failed to render"
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
        response.request().postDataJSON()?.action === action
    ),
    button.press("Enter")
  ]);
  assert(
    response.ok(),
    `${buttonName} POST failed with HTTP ${response.status()}`
  );
  await response.finished();
  await settled();
  const alerts = await page.locator("[role=alert]").allTextContents();
  assert(!alerts.length, buttonName + " failed: " + alerts.join(";"));
}
async function editableReviewIdle() {
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save review"
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
  const path = dir + "mercury-" + name + ".png";
  writeFileSync(path, await page.screenshot({ fullPage: true }), {
    mode: 0o600
  });
  chmodSync(path, 0o600);
}
async function value(label, expected) {
  assert(
    (await page.getByLabel(label, { exact: true }).inputValue()) === expected,
    "Unexpected " + label
  );
}
try {
  if (phase === "review") {
    await visit("missing");
    let body = await page.locator("body").innerText();
    assert(
      body.includes("Mercury payment evidence"),
      "Missing payment evidence"
    );
    assert(
      body.includes("Mercury Browser Example Supplies"),
      "Missing payment payee"
    );
    assert(
      body.includes("Synthetic purchase payment for browser acceptance"),
      "Missing payment memo"
    );
    assert(
      body.includes("No eligible receipt or invoice is attached yet."),
      "No meaningful missing-document explanation"
    );
    assert(
      body.includes("Gmail candidates are retained for later review."),
      "Gmail deferral not explained"
    );
    assert(
      (await page
        .getByRole("combobox", { name: "Preview document", exact: true })
        .count()) === 0,
      "Payment-only/Gmail source leaked into preview"
    );
    assert(
      await page
        .getByRole("button", { name: "Parse again", exact: true })
        .isDisabled(),
      "No-file parse is enabled"
    );
    await fill("Invoice number", "MISSING-NOTE-" + state.run);
    await save();
    await page.reload();
    await settled();
    await value("Invoice number", "MISSING-NOTE-" + state.run);
    assert(
      /needs document/i.test(await page.locator("body").innerText()),
      "Missing-document save changed status misleadingly"
    );
    await screenshot("missing");
    results.push(
      "Missing Mercury: payment context, deferred Gmail, disabled parsing, saved review/reload"
    );
    await visit("unsupported");
    body = await page.locator("body").innerText();
    assert(
      body.includes("unsupported-invoice.xlsx"),
      "Unsupported upstream filename is hidden"
    );
    assert(
      /PDF.*PNG.*JPEG/.test(body),
      "Unsupported source has no supported-format recovery"
    );
    assert(
      await page
        .getByRole("button", { name: "Parse again", exact: true })
        .isDisabled(),
      "Unsupported file can start parsing"
    );
    await screenshot("unsupported");
    results.push(
      "Unsupported XLSX: acquisition status and recovery, no parsing"
    );
    await visit("legacy_primary");
    const legacyPrimary = page.getByRole("combobox", {
      name: "Invoice document to parse",
      exact: true
    });
    assert(
      !(await legacyPrimary.isDisabled()),
      "Stale Gmail primary cannot be replaced by the sole Mercury document"
    );
    await legacyPrimary.click();
    await page
      .getByRole("option", { name: /mercury-receipt-legacy_primary\.pdf/ })
      .click();
    await page.waitForTimeout(300);
    await save();
    await page.reload();
    await settled();
    assert(
      (await legacyPrimary.innerText()).includes(
        "mercury-receipt-legacy_primary.pdf"
      ),
      "Recovered Mercury primary did not persist"
    );
    await screenshot("legacy-primary");
    results.push(
      "Legacy Gmail primary can be explicitly replaced by sole eligible Mercury file"
    );
    await visit("receipt");
    body = await page.locator("body").innerText();
    assert(
      body.includes("Vendor on document"),
      "Extracted supplier facts missing"
    );
    assert(
      body.includes("receipts@example.com"),
      "Extracted supplier email not visible"
    );
    await value("Invoice number", state.cases.receipt.invoiceNumber);
    await value("Description", "Browser sample fasteners");
    await value("Quantity purchased", "3");
    await value("Net unit price", "14");
    const preview = page.getByRole("combobox", {
      name: "Preview document",
      exact: true
    });
    assert(
      (await preview.innerText()).includes("mercury-receipt-receipt.pdf"),
      "Primary preview does not identify Mercury receipt"
    );
    await preview.click();
    let options = await page.getByRole("option").allTextContents();
    assert(
      options.length === 1 && !options.some((x) => x.includes("gmail")),
      "Gmail/payment placeholder leaked into preview choices"
    );
    await page.keyboard.press("Escape");
    const original = await page
      .getByRole("link", { name: "Open original document", exact: true })
      .getAttribute("href");
    assert(original, "Missing original receipt link");
    assert(
      ["localhost", "127.0.0.1"].includes(new URL(original).hostname),
      "Local signed document URL required"
    );
    const response = await context.request.get(original);
    assert(response.ok(), "Receipt signed URL unavailable");
    assert(
      (await response.body()).subarray(0, 5).toString() === "%PDF-",
      "Original is not the receipt PDF"
    );
    await screenshot("receipt-prefilled");
    await page
      .getByRole("button", { name: "Propose new supplier", exact: true })
      .click();
    await page.waitForTimeout(400);
    const dialog = page.getByRole("dialog");
    assert(
      (await dialog.locator("input[name=name]").inputValue()) ===
        "Mercury Browser Example Supplies",
      "Native supplier proposal name not prefilled"
    );
    await dialog
      .getByRole("button", { name: /^Use proposal\b/ })
      .evaluate((b) => b.closest("form").requestSubmit(b));
    await page.waitForTimeout(500);
    assert(
      (await page.getByRole("dialog").count()) === 0,
      "Supplier proposal did not validate"
    );
    await combo("Line type", "Consumable");
    await page
      .getByRole("button", { name: "Propose new item", exact: true })
      .click();
    await page.waitForTimeout(500);
    const itemDialog = page.getByRole("dialog");
    await itemDialog
      .locator("input[name=id]")
      .fill("MB-" + state.run.toUpperCase());
    assert(
      (await itemDialog.locator("input[name=name]").inputValue()) ===
        "Browser sample fasteners",
      "Native item name not prefilled"
    );
    const unit = await itemDialog
      .locator("input[name=unitOfMeasureCode]")
      .inputValue();
    assert(
      unit === "EA",
      "Native item stock unit not prefilled from exact purchase unit"
    );
    await screenshot("proposals");
    await itemDialog
      .getByRole("button", { name: /^Use proposal\b/ })
      .evaluate((b) => b.closest("form").requestSubmit(b));
    await page.waitForTimeout(500);
    assert(
      (await page.getByRole("dialog").count()) === 0,
      "Item proposal did not validate"
    );
    await page
      .getByLabel("Tax, discounts, and shipping are represented correctly", {
        exact: true
      })
      .check();
    await combo("Invoice location", "Headquarters");
    await combo("Inventory location", "Headquarters");
    await save();
    await value("Inventory units per purchase unit", "1");
    assert(
      !(await page
        .getByRole("button", { name: "Approve and create draft", exact: true })
        .isDisabled()),
      "Fully reviewed receipt is not ready for approval"
    );
    await screenshot("ready");
    results.push(
      "Receipt: real PDF preview, complete extracted facts, native supplier/item prefills and Ready"
    );
    await visit("multiple");
    assert(
      await page
        .getByRole("button", { name: "Parse again", exact: true })
        .isDisabled(),
      "Unselected multi-Mercury parse is enabled"
    );
    await page
      .getByRole("combobox", { name: "Invoice document to parse", exact: true })
      .click();
    options = await page.getByRole("option").allTextContents();
    assert(
      options.length === 2 && !options.some((x) => x.includes("gmail")),
      "Primary choices do not match the two Mercury documents"
    );
    await page
      .getByRole("option", { name: /mercury-receipt-multiple\.pdf/ })
      .click();
    await page.waitForTimeout(300);
    const reason = page.getByLabel(
      /Review reason for .*mercury-payment-confirmation\.pdf/
    );
    await reason.fill(
      "Payment confirmation only; the selected receipt contains the purchase lines."
    );
    await reason.blur();
    assert(
      await page
        .getByRole("button", { name: "Parse again", exact: true })
        .isDisabled(),
      "Unsaved source choice starts parsing"
    );
    await save();
    await page.reload();
    await settled();
    assert(
      (
        await page
          .getByRole("combobox", { name: "Preview document", exact: true })
          .innerText()
      ).includes("mercury-receipt-multiple.pdf"),
      "Selected Mercury receipt not initial preview after reload"
    );
    assert(
      !(await page
        .getByRole("button", { name: "Parse again", exact: true })
        .isDisabled()),
      "Saved primary cannot be queued"
    );
    await parseAgain();
    await screenshot("multiple-selected");
    results.push(
      "Multiple Mercury files: explicit saved primary and supporting reason; Gmail excluded; queued canonical parse"
    );
  } else if (phase === "approve") {
    await visit("multiple");
    await value("Invoice number", state.cases.multiple.invoiceNumber);
    await value("Description", "Browser sample fasteners");
    await screenshot("multiple-parsed");
    results.push("Selected Mercury source visibly parsed");
    await visit("receipt");
    if (!/approved/i.test(await page.locator("body").innerText())) {
      await postAction("Approve and create draft", "approve");
    }
    await page
      .getByRole("link", { name: "Open invoice", exact: true })
      .waitFor({ state: "visible" });
    assert(
      /approved/i.test(await page.locator("body").innerText()),
      "Synthetic approval did not complete"
    );
    await page.getByRole("link", { name: "Open invoice", exact: true }).click();
    await page.waitForURL("**/purchase-invoice/**");
    await settled();
    const body = await page.locator("body").innerText();
    assert(
      /draft/i.test(body) && body.includes("Browser sample fasteners"),
      "Native Draft lacks the reviewed item"
    );
    await screenshot("native-draft");
    results.push("Synthetic approval opens native Draft with reviewed line");
  } else throw Error("Unsupported browser phase");
  assert(
    failures.length === 0,
    "Browser runtime errors: " + failures.join(";")
  );
  writeFileSync(
    dir + "mercury-browser-" + phase + "-results.json",
    JSON.stringify({ passed: true, results }, null, 2),
    { mode: 0o600 }
  );
  process.stdout.write(`${JSON.stringify({ passed: true, results })}\n`);
} catch (error) {
  await screenshot("error").catch(() => {
    // Keep reporting the original failure if screenshot capture is unavailable.
  });
  writeFileSync(
    dir + "mercury-browser-error.txt",
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
    { mode: 0o600 }
  );
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
} finally {
  await context.close();
}
