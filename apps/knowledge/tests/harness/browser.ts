/** Browser-test helpers shared by the knowledge specs. Test-only code. */
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page
} from "@playwright/test";

export const e2eGateway =
  process.env.KNOWLEDGE_E2E_GATEWAY_URL ?? "http://127.0.0.1:4301";
export const queryFixture =
  process.env.KNOWLEDGE_E2E_QUERY_FIXTURE_URL ?? "http://127.0.0.1:4302";

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

export async function waitForClientNavigation(page: Page) {
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
