/** Browser-side helpers shared by the acceptance specs: synthetic PDFs, actor
 * contexts with the synthetic IAP cookie, and the upload/review/publish journey. */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { ACTOR_COOKIE, type Actor, ASSERTION_COOKIE } from "./assertion";
import { submitSearch, waitForClientNavigation } from "./browser";

export const e2eGateway =
  process.env.KNOWLEDGE_E2E_GATEWAY_URL ?? "http://127.0.0.1:4301";

export function textPdf(text: string): Buffer {
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

export type ActorSession = { context: BrowserContext; page: Page };

async function contextWithCookie(
  browser: Browser,
  name: string,
  value: string
): Promise<ActorSession> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name,
      value,
      domain: "localhost",
      path: "/",
      secure: true,
      sameSite: "Lax"
    }
  ]);
  return { context, page: await context.newPage() };
}

/** Sign in as a fixture actor through the shorthand cookie the harness mints for. */
export function actorPage(browser: Browser, actor: Actor) {
  return contextWithCookie(browser, ACTOR_COOKIE, actor);
}

/** Present an explicit (possibly forged) synthetic assertion. */
export function assertionPage(browser: Browser, assertion: string) {
  return contextWithCookie(
    browser,
    ASSERTION_COOKIE,
    encodeURIComponent(assertion)
  );
}

/** One hydration barrier for the whole suite. This file used to carry its own,
 * waiting on `window.__reactRouterManifest` — which is set by an inline script
 * in the server-rendered HTML and so is true even when the client entry never
 * ran. `./browser` replaced it with `__reactRouterDataRouter` plus bounded
 * reloads; re-exporting rather than keeping a second copy is what stops the
 * two from drifting apart again. */
export { waitForClientNavigation } from "./browser";

export async function search(page: Page, term: string) {
  await page.goto("/");
  // The submit button is disabled until a hydrated client holds the typed text,
  // so without these two the click waits out `actionTimeout` against a
  // permanently disabled button and the failure is reported as the response
  // that never arrived. Observed twice in seven cold iterations before this.
  await waitForClientNavigation(page);
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/query" &&
      candidate.request().method() === "POST"
  );
  await submitSearch(page, term);
  return (await response).status();
}

/**
 * A refused search answers 403 and says so. The exact status is the assertion:
 * `>= 400` passed just as happily on the 503 this used to return, which is what
 * let a denial reach a reader as "Manual search is unavailable."
 */
export async function expectSearchDenied(page: Page, term: string) {
  const status = await search(page, term);
  expect(status).toBe(403);
  await expect(page.getByRole("alert")).toHaveText(
    "You do not have permission for this action in this library."
  );
}

/** Upload, review, publish and locate one synthetic manual; returns its download path. */
export async function publishManual(
  page: Page,
  options: { partNumber: string; title: string; pdf: Buffer }
): Promise<string> {
  // A freshly started Vite portal may reload the page once while it optimizes
  // dependencies, which clears the chosen file; retry the capture on a clean page.
  for (let attempt = 0; ; attempt += 1) {
    await page.goto("/intake");
    await waitForClientNavigation(page);
    await page.getByLabel("Manual file").setInputFiles({
      name: "acceptance-manual.pdf",
      mimeType: "application/pdf",
      buffer: options.pdf
    });
    try {
      await Promise.all([
        page.waitForURL(/\/intake\/[A-Za-z0-9_-]+$/, { timeout: 20_000 }),
        page.getByRole("button", { name: "Upload manual" }).click()
      ]);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByLabel("Source evidence").textContent();
      },
      { timeout: 90_000 }
    )
    .toContain(options.partNumber);
  await waitForClientNavigation(page);
  await page.getByLabel("Title").fill(options.title);
  await page.getByLabel("Manufacturer").fill("Example Motors");
  await page.getByLabel("Part number").fill(options.partNumber);
  await page.getByLabel("Revision").fill("A");
  await page.getByLabel("Machine").fill("Test bench");
  const reviewed = page.waitForResponse(
    (response) =>
      /\/intake\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Save review" }).click();
  expect((await reviewed).status()).toBe(204);
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
  expect(await search(page, options.partNumber)).toBe(200);
  const download = page.getByRole("link", {
    name: "Download original",
    exact: true
  });
  await expect(download).toBeVisible();
  const href = await download.getAttribute("href");
  const downloadPath = new URL(href ?? "", page.url()).pathname;
  expect(downloadPath).toMatch(/^\/documents\/[^/]+\/versions\/[^/]+$/);
  return downloadPath;
}
