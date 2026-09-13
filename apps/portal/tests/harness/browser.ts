/** Browser-test helpers shared by the portal specs. Test-only code. */
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page
} from "@playwright/test";

export const e2eGateway =
  process.env.PORTAL_E2E_GATEWAY_URL ?? "http://127.0.0.1:4301";
export const queryFixture =
  process.env.PORTAL_E2E_QUERY_FIXTURE_URL ?? "http://127.0.0.1:4302";

/** A one-page PDF whose only text is `text`, so extraction is deterministic. */
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

export async function actorPage(
  browser: Browser,
  actor: "bob" | "alice"
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: "portal_e2e_actor",
      value: actor,
      domain: "localhost",
      path: "/",
      secure: true,
      sameSite: "Lax"
    }
  ]);
  return { context, page: await context.newPage() };
}

/** React Router assigns this from `HydratedRouter`, so it exists only once
 * the client entry has actually run. `window.__reactRouterManifest` is NOT
 * that signal: an inline module script in the server-rendered HTML assigns it
 * after importing the route modules, so it is set even when
 * `entry.client.tsx` never loads. */
type HydratedWindow = { __reactRouterDataRouter?: unknown };

const HYDRATION_WINDOW_MS = 15_000;
const HYDRATION_LOADS = 4;

async function hydratedWithin(page: Page, timeout: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => Boolean((window as HydratedWindow).__reactRouterDataRouter),
      undefined,
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

/** Waits until the client bundle has taken over the server-rendered HTML.
 * Every portal mutation is client-side (`onSubmit` plus `fetch`), and the
 * search form's button is disabled until a hydrated client has the typed
 * text, so an unhydrated page never becomes usable on its own.
 *
 * The reload is what a cold Vite dev server needs: while the client entry is
 * being imported, the dependency optimizer can re-bundle a newly discovered
 * package and invalidate `node_modules/.vite/deps`; the in-flight import then
 * fails with `504 (Outdated Optimize Dep)` and nothing retries it, leaving the
 * page server-rendered for good. Reloading picks up the re-bundled
 * dependencies. Bounded, because a page that never hydrates must say so
 * rather than consume the whole test timeout. */
export async function waitForClientNavigation(page: Page) {
  for (let load = 0; load < HYDRATION_LOADS; load += 1) {
    if (load > 0) await page.reload();
    if (await hydratedWithin(page, HYDRATION_WINDOW_MS)) {
      await page.waitForTimeout(250);
      return;
    }
  }
  throw new Error(
    `The client never hydrated ${page.url()} across ${HYDRATION_LOADS} loads`
  );
}

/** Types one query into the portal and submits it. The search box is a
 * controlled input and the button is disabled while it holds no text, so the
 * enabled button is a precondition of the click: `click()` has no action
 * timeout of its own and would otherwise wait out the entire test. */
export async function submitSearch(page: Page, text: string) {
  await page.getByLabel("Search manuals").fill(text);
  const submit = page.getByRole("button", { name: "Search manuals" });
  await expect(submit).toBeEnabled();
  await submit.click();
}

/** Reloads the review page until its source evidence contains `text`, then
 * waits for hydration so the next interaction is a client-side mutation. */
export async function waitForEvidence(page: Page, text: string) {
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByLabel("Source evidence").textContent();
      },
      { timeout: 90_000 }
    )
    .toContain(text);
  await waitForClientNavigation(page);
}
