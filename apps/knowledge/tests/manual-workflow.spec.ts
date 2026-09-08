import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test
} from "@playwright/test";

const e2eGateway =
  process.env.KNOWLEDGE_E2E_GATEWAY_URL ?? "http://127.0.0.1:4301";
const queryFixture =
  process.env.KNOWLEDGE_E2E_QUERY_FIXTURE_URL ?? "http://127.0.0.1:4302";
const runId = crypto.randomUUID();
const manualTitle = `E2E motor manual ${runId}`;
const manualPart = `EM-${runId.slice(0, 8)}`;
const replacementPart = `${manualPart}-B`;

function textPdf(text: string): Buffer {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

const manualPdf = textPdf(
  `${manualPart} ${manualTitle} revision A Test bench replacement procedure`
);
const replacementPdf = textPdf(
  `${replacementPart} ${manualTitle} revision B Test bench inspection procedure`
);

async function actorPage(
  browser: Browser,
  actor: "bob" | "alice"
): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: "knowledge_e2e_actor",
      value: actor,
      domain: "localhost",
      path: "/",
      secure: true,
      sameSite: "Lax"
    }
  ]);
  return { context, page: await context.newPage() };
}

async function waitForClientNavigation(page: Page) {
  // React Router progressively enhances forms. In a cold Vite server the route
  // module can arrive after the SSR HTML, so wait for the client bundle before
  // exercising a mutation rather than falling back to an unhydrated form post.
  await page.waitForFunction(() =>
    Boolean(
      (window as { __reactRouterManifest?: unknown }).__reactRouterManifest
    )
  );
  await page.waitForTimeout(250);
}

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
  await page.getByLabel("Search manuals").fill(manualPart);
  await page.getByRole("button", { name: "Search manuals" }).click();
  const download = page.getByRole("link", {
    name: "Download original",
    exact: true
  });
  await expect(download).toBeVisible();
  const searchMilliseconds = performance.now() - publishStarted;
  const repeated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/query" &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Search manuals" }).click();
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
    await alice.page.getByLabel("Search manuals").fill(manualPart);
    await alice.page.getByRole("button", { name: "Search manuals" }).click();
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
    await bob.page.getByLabel("Search manuals").fill(manualPart);
    await bob.page.getByRole("button", { name: "Search manuals" }).click();
    await expect(bob.page.getByRole("alert")).toBeVisible();
    const revokedOriginal = await bob.page.goto(downloadPath!);
    expect(revokedOriginal?.status()).not.toBe(200);

    // Restoration is test-fixture cleanup only; removal itself is still driven
    // from the browser confirmation UI and the real worker tombstone handler.
    expect(
      (await request.post(`${e2eGateway}/__e2e/restore/bob`)).ok()
    ).toBeTruthy();
    await bob.page.goto("/");
    await bob.page.getByLabel("Search manuals").fill(manualPart);
    await bob.page.getByRole("button", { name: "Search manuals" }).click();
    await bob.page.getByRole("link", { name: "Remove manual" }).first().click();
    await Promise.all([
      bob.page.waitForURL("/"),
      bob.page.getByRole("button", { name: "Confirm removal" }).click()
    ]);
    await bob.page.getByLabel("Search manuals").fill(manualPart);
    await bob.page.getByRole("button", { name: "Search manuals" }).click();
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
    await bob.page.getByLabel("Title").fill(`${manualPart} duplicate`);
    await bob.page.getByLabel("Manufacturer").fill("E2E Motors");
    await bob.page.getByLabel("Part number").fill(manualPart);
    await bob.page.getByLabel("Revision").fill("A");
    await bob.page.getByLabel("Machine").fill("Test bench");
    const duplicateReview = bob.page.waitForResponse(
      (response) =>
        /\/intake\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST"
    );
    await bob.page.getByRole("button", { name: "Save review" }).click();
    expect((await duplicateReview).status()).toBe(409);

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
    await bob.page.getByLabel("Search manuals").fill(replacementPart);
    await bob.page.getByRole("button", { name: "Search manuals" }).click();
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
