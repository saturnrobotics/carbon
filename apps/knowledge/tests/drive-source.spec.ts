import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * Drive connector workflow against the loopback fixture
 * (`apps/knowledge-worker/src/test/local-drive.ts`): an enrolled Drive appears
 * under Settings, a synchronized manual is found through the query service
 * after a live Drive check, and a folder permission change hides it — first
 * through the live check alone, then through the synchronized ACL.
 * The Drive is in-memory; no Google credential or endpoint is used.
 *
 * The Drive fixture is a SEPARATE pair of endpoints from the manual library's:
 * that query service is pinned to the upload source and can never answer for a
 * Drive one, and its gateway admits no Drive caller. When only one fixture
 * runs, both pairs are the same two ports, which is why these default to them.
 */
const gateway =
  process.env.KNOWLEDGE_E2E_DRIVE_GATEWAY_URL ?? "http://127.0.0.1:4301";
const queryFixture =
  process.env.KNOWLEDGE_E2E_DRIVE_QUERY_URL ?? "http://127.0.0.1:4302";
const manualTitle = "Drive manual DM-100";

async function actorPage(browser: Browser, actor: "bob" | "alice") {
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

async function control(path: string) {
  const response = await fetch(new URL(path, gateway), { method: "POST" });
  if (!response.ok && response.status !== 204)
    throw new Error(`fixture control ${path} answered ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function queryEvidence(
  actor: "bob" | "alice"
): Promise<{ status: number; titles: string[] }> {
  const response = await fetch(new URL("/v1/query", queryFixture), {
    method: "POST",
    headers: {
      authorization: "Bearer e2e-service",
      "x-portal-user-evidence": `e2e-iap:${actor}`,
      "x-portal-company-id": "company-b",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      requestId: `request_${crypto.randomUUID().replace(/-/g, "")}`,
      text: "DM-100 torque table",
      mode: "locate",
      locale: "en-US"
    })
  });
  const result = (await response.json()) as {
    evidence?: Array<{ title: string }>;
  };
  return {
    status: response.status,
    titles: (result.evidence ?? []).map((item) => item.title)
  };
}

async function evidenceTitles(actor: "bob" | "alice"): Promise<string[]> {
  const result = await queryEvidence(actor);
  expect(result.status).toBe(200);
  return result.titles;
}

test.describe.configure({ mode: "serial" });

// Seed before, clean up after. The fixture seeds at process start too, but the
// cleanup below removes that seed, so without this the suite passed once and
// then found no enrollment on every later run against the same stack.
test.beforeAll(async () => {
  await control("/__e2e/drive/reset");
});

test.afterAll(async () => {
  await control("/__e2e/drive/cleanup");
});

test("an enrolled Drive is listed with its scope, owner and eligibility, and only for an admitted reader", async ({
  browser
}) => {
  const bob = await actorPage(browser, "bob");
  await bob.page.goto("/settings/sources");
  const source = bob.page.getByTestId("drive-source");
  await expect(source).toHaveCount(1);
  await expect(source).toContainText("Engineering drive");
  await expect(source).toContainText(
    "Shared Drive drive-e2e: 1 enrolled folder"
  );
  await expect(source).toContainText("Read-only (no domain-wide delegation)");
  await expect(source).toContainText("No external provider is admitted");
  await expect(source).not.toContainText("secrets/");
  await bob.context.close();

  // Alice authenticates at this portal and reaches the same page. She holds no
  // grant on the Drive source, so the enrollment is not merely unusable to her
  // — it is not disclosed at all.
  const alice = await actorPage(browser, "alice");
  await alice.page.goto("/settings/sources");
  await expect(alice.page.getByTestId("drive-sources-empty")).toBeVisible();
  await expect(alice.page.getByText("Engineering drive")).toHaveCount(0);
  await alice.context.close();
});

test("a synchronized manual is found only after the reader's live Drive check passes, and disappears when the folder permission changes", async () => {
  expect(await evidenceTitles("bob")).toEqual([]);
  const synced = (await control("/__e2e/drive/sync")) as { mode: string };
  expect(synced.mode).toBe("initial");
  expect(await evidenceTitles("bob")).toEqual([manualTitle]);
  // Alice is a fixture user of another company and the loopback stack binds no
  // identity for her here, so the read handler refuses her request outright
  // rather than answering it. Either way she receives no Drive evidence; that
  // she is refused before retrieval is the stronger of the two.
  const refused = await queryEvidence("alice");
  expect(refused.status).not.toBe(200);
  expect(refused.titles).toEqual([]);

  // Drive revokes the folder. Before the connector has synchronized, the
  // local ACL still grants bob, and the live check alone must hide the manual.
  await control("/__e2e/drive/revoke-folder");
  expect(await evidenceTitles("bob")).toEqual([]);

  // After synchronization the descendant's source grant is gone as well.
  const resynced = (await control("/__e2e/drive/sync")) as { mode: string };
  expect(resynced.mode).toBe("incremental");
  expect(await evidenceTitles("bob")).toEqual([]);
});

test("the settings page reflects the last synchronization and a sync can be requested by an administrator only", async ({
  browser
}) => {
  const bob = await actorPage(browser, "bob");
  await bob.page.goto("/settings/sources");
  const source = bob.page.getByTestId("drive-source");
  await expect(source).toContainText("Last sync succeeded");
  await waitForClientNavigation(bob.page);
  const submitted = bob.page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith("/settings/sources")
  );
  await source.getByRole("button", { name: "Reconcile now" }).click();
  // bob holds read at the source, not admin: the connector refuses the request
  // and the page reports nothing requested. Wait for the submission to land so
  // the absent confirmation is a refusal rather than an unfinished click.
  expect((await submitted).status()).toBeLessThan(400);
  await expect(bob.page.getByRole("status")).toHaveCount(0);
  await bob.context.close();
});

async function waitForClientNavigation(page: Page) {
  await page.waitForFunction(() =>
    Boolean(
      (window as { __reactRouterManifest?: unknown }).__reactRouterManifest
    )
  );
  await page.waitForTimeout(250);
}
