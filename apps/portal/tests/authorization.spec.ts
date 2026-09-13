/**
 * Authorization at the browser boundary (acceptance A02, A09, A10, A11): another
 * company's employee gets nothing, a warmed search stops when the library grant
 * is revoked, and a removed manual can no longer be downloaded. The synthetic
 * identity is the loopback harness; row security, the Redis-backed query cache
 * and the tombstone handler are the production paths.
 */
import { expect, test } from "@playwright/test";
import { restoreLibraryGrant, revokeLibraryGrant } from "./harness/database";
import {
  actorPage,
  e2eGateway,
  expectSearchDenied,
  publishManual,
  search,
  textPdf
} from "./harness/manual";

const runId = crypto.randomUUID();
const partNumber = `AZ-${runId.slice(0, 8)}`;
const title = `Acceptance authorization manual ${runId}`;

test.setTimeout(240_000);

test("cross-company denial, grant revocation and deletion each stop access", async ({
  browser,
  request
}) => {
  const bob = await actorPage(browser, "bob");
  const alice = await actorPage(browser, "alice");
  try {
    const downloadPath = await publishManual(bob.page, {
      partNumber,
      title,
      pdf: textPdf(`${partNumber} ${title} revision A Test bench procedure`)
    });
    // Warm the query cache: the second identical search is served from Redis.
    expect(await search(bob.page, partNumber)).toBe(200);
    await expect(
      bob.page.getByRole("link", { name: "Download original", exact: true })
    ).toBeVisible();

    // Alice is bound to company-a. The portal is configured for company-b, so her
    // verified identity resolves to no membership: no results, no download, no upload.
    await expectSearchDenied(alice.page, partNumber);
    await expect(alice.page.getByText(title)).toHaveCount(0);
    const deniedDownload = await alice.context.request.get(downloadPath);
    expect(deniedDownload.status()).not.toBe(200);
    await alice.page.goto("/intake");
    await alice.page.getByLabel("Manual file").setInputFiles({
      name: "alice-denied.pdf",
      mimeType: "application/pdf",
      buffer: textPdf(`${partNumber} alice`)
    });
    const deniedCapture = alice.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/intake" &&
        response.request().method() === "POST"
    );
    await alice.page.getByRole("button", { name: "Upload manual" }).click();
    expect((await deniedCapture).status()).toBeGreaterThanOrEqual(400);

    // Revoking the library grant in PostgreSQL bumps the source ACL epoch and
    // fails the per-delivery evidence recheck, so the warmed search stops.
    revokeLibraryGrant();
    try {
      await expect
        .poll(
          async () => {
            const status = await search(bob.page, partNumber);
            const shown = await bob.page.getByText(title).count();
            return status >= 400 || shown === 0;
          },
          { timeout: 30_000 }
        )
        .toBe(true);
      await expect(bob.page.getByText(title)).toHaveCount(0);
      const revokedDownload = await bob.context.request.get(downloadPath);
      expect(revokedDownload.status()).not.toBe(200);
    } finally {
      restoreLibraryGrant();
    }
    await expect
      .poll(
        async () => {
          await search(bob.page, partNumber);
          return bob.page.getByText(title).count();
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0);
    const restoredDownload = await bob.context.request.get(downloadPath);
    expect(restoredDownload.status()).toBe(200);

    // Removal from the browser confirmation UI tombstones the manual; the exact
    // version download is denied afterwards even with an otherwise valid identity.
    await search(bob.page, partNumber);
    await bob.page.getByRole("link", { name: "Remove manual" }).first().click();
    await Promise.all([
      bob.page.waitForURL("/"),
      bob.page.getByRole("button", { name: "Confirm removal" }).click()
    ]);
    await expect
      .poll(
        async () => {
          await search(bob.page, partNumber);
          return bob.page.getByText("No matching manuals found.").count();
        },
        { timeout: 30_000 }
      )
      .toBe(1);
    const removedDownload = await bob.context.request.get(downloadPath);
    expect(removedDownload.status()).not.toBe(200);
  } finally {
    restoreLibraryGrant();
    await request.post(`${e2eGateway}/__e2e/restore/bob`);
    if (process.env.PORTAL_E2E_PRESERVE_FIXTURE !== "1")
      await request.post(`${e2eGateway}/__e2e/cleanup`);
    await Promise.all([bob.context.close(), alice.context.close()]);
  }
});
