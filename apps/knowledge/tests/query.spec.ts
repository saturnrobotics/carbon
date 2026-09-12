import { expect, type Page, test } from "@playwright/test";
import {
  actorPage,
  textPdf,
  waitForClientNavigation,
  waitForEvidence
} from "./harness/browser";

const runId = crypto.randomUUID();
const manualPart = `QM-${runId.slice(0, 8)}`;
const manualTitle = `E2E query manual ${runId}`;
const manualPdf = textPdf(
  `${manualPart} ${manualTitle} revision C Spindle torque procedure`
);

async function publishManual(page: Page) {
  await page.goto("/intake");
  await waitForClientNavigation(page);
  await page.getByLabel("Manual file").setInputFiles({
    name: "e2e-query-manual.pdf",
    mimeType: "application/pdf",
    buffer: manualPdf
  });
  await Promise.all([
    page.waitForURL(/\/intake\/[A-Za-z0-9_-]+$/),
    page.getByRole("button", { name: "Upload manual" }).click()
  ]);
  await waitForEvidence(page, manualPart);
  await page.getByLabel("Title").fill(manualPart);
  await page.getByLabel("Manufacturer").fill("E2E Motors");
  await page.getByLabel("Part number").fill(manualPart);
  await page.getByLabel("Revision").fill("C");
  await page.getByLabel("Machine").fill("Spindle");
  const saved = page.waitForResponse(
    (response) =>
      /\/intake\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Save review" }).click();
  expect((await saved).status()).toBe(204);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Publish manual" })
  ).toBeEnabled();
  const published = page.waitForResponse(
    (response) =>
      /\/intake\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Publish manual" }).click();
  expect((await published).status()).toBeLessThan(400);
}

async function search(page: Page, text: string) {
  const answered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/query" &&
      response.request().method() === "POST"
  );
  await page.getByLabel("Search manuals").fill(text);
  await page.getByRole("button", { name: "Search manuals" }).click();
  return answered;
}

test.setTimeout(180_000);

test("the read portal streams evidence, cites the exact version, and keeps compact follow-up context", async ({
  browser
}) => {
  const bob = await actorPage(browser, "bob");
  try {
    await publishManual(bob.page);
    await bob.page.goto("/");
    await waitForClientNavigation(bob.page);

    // The search is one POST with the text in the body; the answer arrives
    // as an event stream, and the card is the evidence event made visible.
    await expect
      .poll(
        async () => {
          const response = await search(bob.page, manualPart);
          return (
            response.status() === 200 &&
            (await bob.page.getByText(manualPart).count()) > 0
          );
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    const response = await search(bob.page, manualPart);
    expect(response.headers()["content-type"]).toContain(
      "application/x-ndjson"
    );
    expect(response.request().postDataJSON()).toMatchObject({
      text: manualPart,
      mode: "auto",
      context: { conversationId: expect.any(String) }
    });
    expect(new URL(response.url()).search).toBe("");

    const card = bob.page.locator(".evidence-card").first();
    await expect(card).toContainText("[1]");
    await expect(card).toContainText("Current version");
    const original = card.getByRole("link", {
      name: "Download original",
      exact: true
    });
    await expect(original).toBeVisible();
    expect(await original.getAttribute("href")).toMatch(
      /^\/documents\/[^/]+\/versions\/[^/]+$/
    );
    await expect(
      bob.page.getByText(
        "A follow-up question keeps the evidence shown here in context."
      )
    ).toBeVisible();

    // A follow-up whose words match nothing keeps the shown manual in
    // context; after "Start a new question" the same words find nothing.
    const followUp = await search(bob.page, "zzqx-no-such-term");
    expect(followUp.status()).toBe(200);
    await expect(bob.page.locator(".evidence-card").first()).toContainText(
      manualPart
    );
    await bob.page
      .getByRole("button", { name: "Start a new question" })
      .click();
    await expect(bob.page.locator(".evidence-card")).toHaveCount(0);
    const fresh = await search(bob.page, "zzqx-no-such-term");
    expect(fresh.status()).toBe(200);
    await expect(
      bob.page.getByText("No matching manuals found.")
    ).toBeVisible();
    await expect(bob.page.locator(".evidence-card")).toHaveCount(0);
  } finally {
    await bob.context.close();
  }
});

test("another company's reader gets neither the evidence nor the follow-up context", async ({
  browser
}) => {
  const alice = await actorPage(browser, "alice");
  try {
    await alice.page.goto("/");
    await waitForClientNavigation(alice.page);
    const denied = await search(alice.page, manualPart);
    expect(denied.status()).not.toBe(200);
    await expect(alice.page.getByRole("alert")).toBeVisible();
    await expect(alice.page.getByText(manualTitle)).toHaveCount(0);
    await expect(alice.page.locator(".evidence-card")).toHaveCount(0);
  } finally {
    await alice.context.close();
  }
});
