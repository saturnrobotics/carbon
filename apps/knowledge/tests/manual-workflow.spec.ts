import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test
} from "@playwright/test";

const e2eGateway = "http://127.0.0.1:4301";
const runId = crypto.randomUUID();
const manualTitle = `E2E motor manual ${runId}`;
const manualPart = `EM-${runId.slice(0, 8)}`;
const manualPdf = Buffer.from(
  `%PDF-1.4\n% ${runId}\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<<>>\n%%EOF\n`,
  "utf8"
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

  await page.goto("/");
  await page.getByLabel("Search manuals").fill(manualPart);
  await page.getByRole("button", { name: "Search manuals" }).click();
  const download = page.getByRole("link", {
    name: "Download original",
    exact: true
  });
  await expect(download).toBeVisible();
  const href = await download.getAttribute("href");
  return href ? new URL(href, page.url()).pathname : null;
}

test.setTimeout(120_000);

test("manual workflow confines capture, review, search, original download, revocation, and removal to the authorized library", async ({
  browser,
  request
}) => {
  const bob = await actorPage(browser, "bob");
  const alice = await actorPage(browser, "alice");
  try {
    const downloadPath = await uploadReviewAndPublish(bob.page);
    expect(downloadPath).toMatch(/^\/documents\/[^/]+\/versions\/[^/]+$/);

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
    expect(Buffer.concat(bytes).subarray(0, 5).toString()).toBe("%PDF-");

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
    await bob.page.getByRole("link", { name: "Remove manual" }).click();
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
  } finally {
    await Promise.all([bob.context.close(), alice.context.close()]);
  }
});
