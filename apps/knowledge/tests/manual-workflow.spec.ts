import { expect, type Page, test } from "@playwright/test";
import {
  actorPage,
  e2eGateway,
  queryFixture,
  submitSearch,
  textPdf,
  waitForClientNavigation
} from "./harness/browser";

const runId = crypto.randomUUID();
const manualTitle = `E2E motor manual ${runId}`;
const manualPart = `EM-${runId.slice(0, 8)}`;
const replacementPart = `${manualPart}-B`;

const manualPdf = textPdf(
  `${manualPart} ${manualTitle} revision A Test bench replacement procedure`
);
const replacementPdf = textPdf(
  `${replacementPart} ${manualTitle} revision B Test bench inspection procedure`
);

async function uploadReviewAndPublish(page: Page) {
  const uploadStarted = performance.now();
  await page.goto("/");
  await waitForClientNavigation(page);
  await page.getByRole("link", { name: "Upload a manual" }).click();
  await waitForClientNavigation(page);
  await page.getByLabel("Manual file").setInputFiles({
    name: "e2e-motor-manual.pdf",
    mimeType: "application/pdf",
    buffer: manualPdf
  });
  await Promise.all([
    page.waitForURL(/\/intake\/[A-Za-z0-9_-]+$/),
    page.getByRole("button", { name: "Upload manual" }).click()
  ]);
  await expect(
    page.getByRole("heading", { name: "Review document" })
  ).toBeVisible();

  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByLabel("Source evidence").textContent();
      },
      { timeout: 90_000 }
    )
    .toContain(manualPart);
  const extractionMilliseconds = performance.now() - uploadStarted;
  await waitForClientNavigation(page);

  await page.getByLabel("Title").fill(manualPart);
  await page.getByLabel("Manufacturer").fill("E2E Motors");
  await page.getByLabel("Part number").fill(manualPart);
  await page.getByLabel("Revision").fill("A");
  await page.getByLabel("Machine").fill("Test bench");
  const savedReview = page.waitForResponse(
    (response) =>
      /\/intake\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Save review" }).click();
  expect((await savedReview).status()).toBe(204);
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

  const publishStarted = performance.now();
  await page.goto("/");
  await waitForClientNavigation(page);
  await submitSearch(page, manualPart);
  const download = page.getByRole("link", {
    name: "Download original",
    exact: true
  });
  await expect(download).toBeVisible();
  const searchMilliseconds = performance.now() - publishStarted;
  // Ask the identical question again, as a NEW question. Repeating it inside
  // the same conversation sends the first answer's evidence back as follow-up
  // context, and context is deliberately part of the answer cache's key, so
  // only a fresh question asks the cache what the first search stored.
  await page.getByRole("button", { name: "Start a new question" }).click();
  const repeated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/query" &&
      response.request().method() === "POST"
  );
  await submitSearch(page, manualPart);
  expect((await repeated).status()).toBe(200);
  const href = await download.getAttribute("href");
  return {
    downloadPath: href ? new URL(href, page.url()).pathname : null,
    extractionMilliseconds,
    searchMilliseconds
  };
}

test.setTimeout(180_000);

test("manual workflow uses real extraction, durable delivery, Redis, and exact immutable download", async ({
  browser,
  request
}, testInfo) => {
  const bob = await actorPage(browser, "bob");
  const alice = await actorPage(browser, "alice");
  try {
    const initialDelivery = await (
      await request.get(`${e2eGateway}/__e2e/status`)
    ).json();
    const initialCache = await (
      await request.get(`${queryFixture}/__e2e/cache`)
    ).json();
    expect(
      (await request.post(`${e2eGateway}/__e2e/fail-next-parser`)).ok()
    ).toBeTruthy();
    const { downloadPath, extractionMilliseconds, searchMilliseconds } =
      await uploadReviewAndPublish(bob.page);
    expect(downloadPath).toMatch(/^\/documents\/[^/]+\/versions\/[^/]+$/);

    await expect
      .poll(
        async () => {
          const response = await request.get(`${e2eGateway}/__e2e/status`);
          return response.json();
        },
        { timeout: 30_000 }
      )
      .toMatchObject({
        pending: 0
      });
    const delivery = await (
      await request.get(`${e2eGateway}/__e2e/status`)
    ).json();
    expect(delivery.injectedFailures).toBe(
      initialDelivery.injectedFailures + 1
    );
    expect(delivery.processAttempts).toBeGreaterThanOrEqual(
      initialDelivery.processAttempts + 2
    );
    expect(delivery.maximumAttempt).toBeGreaterThanOrEqual(1);
    expect(delivery.parserCalls).toBeGreaterThanOrEqual(
      initialDelivery.parserCalls + 1
    );
    const cache = await (
      await request.get(`${queryFixture}/__e2e/cache`)
    ).json();
    expect(cache.sets).toBeGreaterThanOrEqual(initialCache.sets + 1);
    expect(cache.hits).toBeGreaterThanOrEqual(initialCache.hits + 1);
    await testInfo.attach("manual-workflow-timings.json", {
      body: Buffer.from(
        JSON.stringify({ extractionMilliseconds, searchMilliseconds })
      ),
      contentType: "application/json"
    });

    // This is a browser click through the web proxy, not a direct worker call.
    const originalResponse = bob.page.waitForResponse(
      (response) => new URL(response.url()).pathname === downloadPath
    );
    const downloadStarted = bob.page.waitForEvent("download");
    await bob.page
      .getByRole("link", { name: "Download original", exact: true })
      .click();
    const [original, download] = await Promise.all([
      originalResponse,
      downloadStarted
    ]);
    expect(original.status()).toBe(200);
    expect(original.headers()["content-type"]).toContain("application/pdf");
    expect(original.headers()["content-disposition"]).toMatch(/^attachment;/i);
    expect(original.headers()["x-content-type-options"]).toBe("nosniff");
    const stream = await download.createReadStream();
    expect(stream).not.toBeNull();
    const bytes: Buffer[] = [];
    for await (const chunk of stream!) bytes.push(Buffer.from(chunk));
    expect(Buffer.concat(bytes)).toEqual(manualPdf);

    // Alice is a real second fixture user in a different company. The app never
    // receives an actor/company override from the browser; its synthetic test
    // identity is emitted only by the loopback-only server alias.
    await alice.page.goto("/");
    await waitForClientNavigation(alice.page);
    await submitSearch(alice.page, manualPart);
    await expect(alice.page.getByRole("alert")).toBeVisible();
    await expect(alice.page.getByText(manualTitle)).toHaveCount(0);
    const deniedOriginal = await alice.page.goto(downloadPath!);
    expect(deniedOriginal?.status()).not.toBe(200);

    await alice.page.goto("/intake");
    await alice.page.getByLabel("Manual file").setInputFiles({
      name: "alice-denied.pdf",
      mimeType: "application/pdf",
      buffer: manualPdf
    });
    const deniedCapture = alice.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/intake" &&
        response.request().method() === "POST"
    );
    await alice.page.getByRole("button", { name: "Upload manual" }).click();
    expect((await deniedCapture).status()).toBeGreaterThanOrEqual(400);
    await expect(
      alice.page.getByRole("heading", { name: "Review document" })
    ).toHaveCount(0);

    // The gateway flips canonical activity in PostgreSQL. Both the read handler
    // and the worker's test identity seam then deny Bob's next request.
    expect(
      (await request.post(`${e2eGateway}/__e2e/revoke/bob`)).ok()
    ).toBeTruthy();
    await bob.page.goto("/");
    await waitForClientNavigation(bob.page);
    await submitSearch(bob.page, manualPart);
    await expect(bob.page.getByRole("alert")).toBeVisible();
    const revokedOriginal = await bob.page.goto(downloadPath!);
    expect(revokedOriginal?.status()).not.toBe(200);

    // Restoration is test-fixture cleanup only; removal itself is still driven
    // from the browser confirmation UI and the real worker tombstone handler.
    expect(
      (await request.post(`${e2eGateway}/__e2e/restore/bob`)).ok()
    ).toBeTruthy();
    await bob.page.goto("/");
    await waitForClientNavigation(bob.page);
    await submitSearch(bob.page, manualPart);
    await bob.page.getByRole("link", { name: "Remove manual" }).first().click();
    await Promise.all([
      bob.page.waitForURL("/"),
      bob.page.getByRole("button", { name: "Confirm removal" }).click()
    ]);
    await waitForClientNavigation(bob.page);
    await submitSearch(bob.page, manualPart);
    await expect(
      bob.page.getByText("No matching manuals found.")
    ).toBeVisible();
    const removedOriginal = await bob.page.goto(downloadPath!);
    expect(removedOriginal?.status()).not.toBe(200);

    // Upload the identical bytes again. Background processing reuses the
    // immutable extraction, and review rejects the existing content hash.
    await bob.page.goto("/intake");
    await waitForClientNavigation(bob.page);
    await bob.page.getByLabel("Manual file").setInputFiles({
      name: "e2e-motor-manual.pdf",
      mimeType: "application/pdf",
      buffer: manualPdf
    });
    await Promise.all([
      bob.page.waitForURL(/\/intake\/[A-Za-z0-9_-]+$/),
      bob.page.getByRole("button", { name: "Upload manual" }).click()
    ]);
    await expect
      .poll(
        async () => {
          await bob.page.reload();
          return bob.page.getByLabel("Source evidence").textContent();
        },
        { timeout: 90_000 }
      )
      .toContain(manualPart);
    await waitForClientNavigation(bob.page);
    // Identical bytes resolve to the intake that was already published, which
    // the page shows read-only. The server still refuses a review write for
    // the existing content hash, proved through the same route action.
    await expect(
      bob.page.getByText("Published", { exact: true })
    ).toBeVisible();
    await expect(
      bob.page.getByRole("button", { name: "Save review" })
    ).toBeDisabled();
    const duplicateReview = await bob.page.request.post(bob.page.url(), {
      headers: { origin: new URL(bob.page.url()).origin },
      form: {
        intent: "review",
        expectedGeneration: await bob.page
          .locator('input[name="expectedGeneration"]')
          .inputValue(),
        expectedVersion: await bob.page
          .locator('input[name="expectedVersion"]')
          .inputValue(),
        metadata: JSON.stringify({
          title: `${manualPart} duplicate`,
          manufacturer: "E2E Motors",
          partNumber: manualPart,
          revision: "A",
          machine: "Test bench"
        }),
        item: "null"
      }
    });
    expect(duplicateReview.status()).toBe(409);

    // Preserve a second, distinct document for performance and recovery checks.
    // The first document remains tombstoned and its original download denied.
    await bob.page.goto("/intake");
    await waitForClientNavigation(bob.page);
    await bob.page.getByLabel("Manual file").setInputFiles({
      name: "e2e-motor-manual-revision-b.pdf",
      mimeType: "application/pdf",
      buffer: replacementPdf
    });
    await Promise.all([
      bob.page.waitForURL(/\/intake\/[A-Za-z0-9_-]+$/),
      bob.page.getByRole("button", { name: "Upload manual" }).click()
    ]);
    await expect
      .poll(
        async () => {
          await bob.page.reload();
          return bob.page.getByLabel("Source evidence").textContent();
        },
        { timeout: 90_000 }
      )
      .toContain(replacementPart);
    await waitForClientNavigation(bob.page);
    await bob.page.getByLabel("Title").fill(`${manualPart} replacement`);
    await bob.page.getByLabel("Manufacturer").fill("E2E Motors");
    await bob.page.getByLabel("Part number").fill(replacementPart);
    await bob.page.getByLabel("Revision").fill("B");
    await bob.page.getByLabel("Machine").fill("Test bench");
    const replacementReview = bob.page.waitForResponse(
      (response) =>
        /\/intake\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST"
    );
    await bob.page.getByRole("button", { name: "Save review" }).click();
    expect((await replacementReview).status()).toBe(204);
    await bob.page.reload();
    const replacementPublish = bob.page.waitForResponse(
      (response) =>
        /\/intake\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST"
    );
    await bob.page.getByRole("button", { name: "Publish manual" }).click();
    expect((await replacementPublish).status()).toBeLessThan(400);
    await bob.page.goto("/");
    await waitForClientNavigation(bob.page);
    await submitSearch(bob.page, replacementPart);
    await expect(
      bob.page.getByRole("link", { name: "Download original", exact: true })
    ).toBeVisible();
    const replacementDelivery = await (
      await request.get(`${e2eGateway}/__e2e/status`)
    ).json();
    expect(replacementDelivery.parserCalls).toBeGreaterThanOrEqual(
      initialDelivery.parserCalls + 2
    );
  } finally {
    await request.post(`${e2eGateway}/__e2e/restore/bob`);
    if (process.env.KNOWLEDGE_E2E_PRESERVE_FIXTURE !== "1")
      await request.post(`${e2eGateway}/__e2e/cleanup`);
    await Promise.all([bob.context.close(), alice.context.close()]);
  }
});
