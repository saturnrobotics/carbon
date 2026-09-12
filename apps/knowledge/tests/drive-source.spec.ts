import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * Drive connector workflow against the loopback fixture
 * (`apps/knowledge-worker/src/test/local-drive.ts` on 4301/4302): an enrolled
 * Drive appears under Settings, a synchronized manual is found through the
 * query service after a live Drive check, and a folder permission change hides
 * it — first through the live check alone, then through the synchronized ACL.
 * The Drive is in-memory; no Google credential or endpoint is used.
 */
const gateway =
  process.env.KNOWLEDGE_E2E_GATEWAY_URL ?? "http://127.0.0.1:4301";
const queryFixture =
  process.env.KNOWLEDGE_E2E_QUERY_FIXTURE_URL ?? "http://127.0.0.1:4302";
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

async function evidenceTitles(actor: "bob" | "alice"): Promise<string[]> {
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
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    evidence?: Array<{ title: string }>;
  };
  return (result.evidence ?? []).map((item) => item.title);
}

test.describe.configure({ mode: "serial" });

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

  const alice = await actorPage(browser, "alice");
  await alice.page.goto("/settings/sources");
  await expect(alice.page.getByTestId("drive-sources-empty")).toBeVisible();
  await alice.context.close();
});

test("a synchronized manual is found only after the reader's live Drive check passes, and disappears when the folder permission changes", async () => {
  expect(await evidenceTitles("bob")).toEqual([]);
  const synced = (await control("/__e2e/drive/sync")) as { mode: string };
  expect(synced.mode).toBe("initial");
  expect(await evidenceTitles("bob")).toEqual([manualTitle]);
  // A collaborator without a Drive binding never sees it.
  expect(await evidenceTitles("alice")).toEqual([]);

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
  await source.getByRole("button", { name: "Reconcile now" }).click();
  // bob holds read at the source, not admin: the request is refused and the
  // page reports nothing requested.
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
