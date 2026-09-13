import { expect, type Page, test } from "@playwright/test";
import {
  actorPage,
  e2eGateway,
  submitSearch,
  textPdf,
  waitForClientNavigation,
  waitForEvidence
} from "./harness/browser";

const runId = crypto.randomUUID();
const token = runId.slice(0, 8);
const filePart = `IN-${token}`;
const filePdf = textPdf(`${filePart} E2E intake manual revision A Test bench`);
const urlToken = `url${token}`;

async function dropOnDropzone(page: Page, name: string, bytes: Buffer) {
  // A real drop event: the dropzone must copy the file into the form's own
  // input, which is what the multipart request then carries.
  const transfer = await page.evaluateHandle(
    ({ name, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], name, { type: "application/pdf" })
      );
      return transfer;
    },
    { name, bytes: [...bytes] }
  );
  await page.dispatchEvent(".dropzone", "drop", { dataTransfer: transfer });
}

async function submitIntake(page: Page) {
  await Promise.all([
    page.waitForURL(/\/intake\/[A-Za-z0-9_-]+$/),
    page.getByRole("button", { name: "Upload manual" }).click()
  ]);
  await expect(
    page.getByRole("heading", { name: "Review document" })
  ).toBeVisible();
}

function reviewResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      /\/intake\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST"
  );
}

test.setTimeout(240_000);

test.describe("intake review", () => {
  test.afterAll(async ({ request }) => {
    await request.post(`${e2eGateway}/__e2e/grant/bob/admin`);
    if (process.env.KNOWLEDGE_E2E_PRESERVE_FIXTURE !== "1")
      await request.post(`${e2eGateway}/__e2e/cleanup`);
  });

  test("a dropped file is reviewed beside its source pages, linked to an item, and published", async ({
    browser
  }) => {
    const bob = await actorPage(browser, "bob");
    try {
      const { page } = bob;
      await page.goto("/intake");
      await waitForClientNavigation(page);
      await expect(page.getByLabel("Library", { exact: true })).toHaveValue(
        "source-b"
      );
      await expect(page.getByText("Owner: bob")).toBeVisible();
      await expect(
        page.getByLabel("Take a photo of a nameplate or label")
      ).toHaveAttribute("capture", "environment");
      await dropOnDropzone(page, "e2e-intake.pdf", filePdf);
      await expect(page.getByText("Selected: e2e-intake.pdf")).toBeVisible();
      await submitIntake(page);
      await expect(page.getByText("State:")).toBeVisible();

      await waitForEvidence(page, filePart);
      await expect(page.getByText("Needs review")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Publish manual" })
      ).toBeDisabled();
      const sourcePages = page.getByLabel("Source evidence");
      await expect(sourcePages.getByText("Page 1")).toBeVisible();
      await expect(
        sourcePages.getByText("Page images are not available")
      ).toBeVisible();

      // Correcting a proposed field keeps the evidence for that field in view.
      await page.getByLabel("Title").fill(filePart);
      await page.getByLabel("Manufacturer").fill("E2E Motors");
      await page.getByLabel("Part number").fill(filePart);
      await page.getByLabel("Revision").fill("A");
      await page.getByLabel("Machine").fill("Test bench");

      // Existing-item candidates come from the Carbon canonical read through
      // the query gateway; the reviewer picks one or keeps a generic document.
      await page.getByLabel("Search items").fill("E2E motor");
      await page.getByRole("button", { name: "Search items" }).click();
      const candidate = page.getByRole("radio", { name: /EM-100/ });
      await expect(candidate).toBeVisible();
      await expect(page.getByRole("radio", { name: /EP-200/ })).toHaveCount(0);
      await candidate.check();

      const saved = reviewResponse(page);
      await page.getByRole("button", { name: "Save review" }).click();
      expect((await saved).status()).toBe(204);
      await page.reload();
      await waitForClientNavigation(page);
      await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Part number")).toHaveValue(filePart);
      await expect(page.getByText("Saved correction").first()).toBeVisible();
      await expect(page.getByRole("radio", { name: /EM-100/ })).toBeChecked();

      // Publishing is a separate server-checked intent.
      const published = reviewResponse(page);
      await page.getByRole("button", { name: "Publish manual" }).click();
      expect((await published).status()).toBeLessThan(400);
      await page.reload();
      await expect(page.getByText("Published", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Save review" })
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Publish manual" })
      ).toBeDisabled();

      await page.goto("/");
      await waitForClientNavigation(page);
      await submitSearch(page, filePart);
      await expect(
        page.getByRole("link", { name: "Download original", exact: true })
      ).toBeVisible();
    } finally {
      await bob.context.close();
    }
  });

  test("a source URL is fetched through the server fetch policy and refused when private", async ({
    browser
  }) => {
    const bob = await actorPage(browser, "bob");
    try {
      const { page } = bob;
      await page.goto("/intake");
      await waitForClientNavigation(page);
      await page
        .getByLabel("Source URL")
        .fill(`https://manuals.e2e.invalid/${urlToken}.pdf`);
      await expect(
        page.getByLabel("Manual file", { exact: true })
      ).toBeDisabled();
      await submitIntake(page);
      await expect(page.getByText("Fetched from")).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: `https://manuals.e2e.invalid/${urlToken}.pdf`
        })
      ).toBeVisible();
      await waitForEvidence(page, urlToken);

      // The acquisition failure is reported on the upload page itself, apart
      // from any extraction or review state, and nothing is captured.
      await page.goto("/intake");
      await waitForClientNavigation(page);
      await page.getByLabel("Source URL").fill("https://10.0.0.1/manual.pdf");
      const refused = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/intake" &&
          response.request().method() === "POST"
      );
      await page.getByRole("button", { name: "Upload manual" }).click();
      expect((await refused).status()).toBe(422);
      await expect(page.getByRole("alert")).toContainText(
        "could not be fetched"
      );
      await expect(page).toHaveURL(/\/intake$/);
    } finally {
      await bob.context.close();
    }
  });

  test("review and publish are refused without the matching permission", async ({
    browser,
    request
  }) => {
    const bob = await actorPage(browser, "bob");
    const alice = await actorPage(browser, "alice");
    try {
      const { page } = bob;
      await page.goto("/intake");
      await waitForClientNavigation(page);
      await page.getByLabel("Manual file", { exact: true }).setInputFiles({
        name: "e2e-intake-denied.pdf",
        mimeType: "application/pdf",
        buffer: textPdf(`${filePart}-D E2E intake manual revision D`)
      });
      await submitIntake(page);
      const reviewUrl = page.url();
      await waitForEvidence(page, `${filePart}-D`);
      await page.getByLabel("Title").fill(`${filePart}-D`);
      await page.getByLabel("Manufacturer").fill("E2E Motors");
      await page.getByLabel("Part number").fill(`${filePart}-D`);
      await page.getByLabel("Revision").fill("D");
      await page.getByLabel("Machine").fill("Test bench");
      const saved = reviewResponse(page);
      await page.getByRole("button", { name: "Save review" }).click();
      expect((await saved).status()).toBe(204);

      // A second user in another company cannot open the review at all.
      const denied = await alice.page.goto(reviewUrl);
      expect(denied?.status()).toBeGreaterThanOrEqual(400);
      await expect(
        alice.page.getByRole("heading", { name: "Request unavailable" })
      ).toBeVisible();
      await expect(alice.page.getByLabel("Title")).toHaveCount(0);

      // The reviewer keeps review rights but loses publish: the database
      // policy refuses the document write and the review is kept.
      expect(
        (await request.post(`${e2eGateway}/__e2e/grant/bob/review`)).ok()
      ).toBeTruthy();
      await page.reload();
      await waitForClientNavigation(page);
      await expect(
        page.getByRole("button", { name: "Publish manual" })
      ).toBeEnabled();
      const refused = reviewResponse(page);
      await page.getByRole("button", { name: "Publish manual" }).click();
      expect((await refused).status()).toBe(403);
      await expect(page.getByRole("alert")).toContainText(
        "not allowed to publish"
      );
      await page.reload();
      await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
      await expect(page.getByText("Published", { exact: true })).toHaveCount(0);
    } finally {
      await request.post(`${e2eGateway}/__e2e/grant/bob/admin`);
      await Promise.all([bob.context.close(), alice.context.close()]);
    }
  });
});
