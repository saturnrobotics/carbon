/**
 * Workforce sign-in at the browser boundary (acceptance A01 shape, A02 denials).
 * The Google credential itself is synthetic; audience, issuer, freshness and
 * access-level decisions are the production `verifyIapBrowserRequest`, and the
 * canonical revocation path runs in PostgreSQL through the loopback gateway.
 */
import { expect, test } from "@playwright/test";
import {
  actorAssertion,
  epochSeconds,
  mintSyntheticAssertion,
  SYNTHETIC_ACCESS_LEVEL,
  SYNTHETIC_IAP_ISSUER
} from "./harness/assertion";
import {
  actorPage,
  assertionPage,
  e2eGateway,
  expectSearchDenied,
  search,
  textPdf
} from "./harness/manual";

const probe = `SSO-${crypto.randomUUID().slice(0, 8)}`;
function forgedAssertion(): string {
  const payload = actorAssertion("bob").split(".")[0]!;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  return mintSyntheticAssertion(claims, "not-the-harness-key");
}

const denied = [
  { name: "a forged signature", assertion: forgedAssertion },
  {
    name: "the wrong backend audience",
    assertion: () =>
      actorAssertion("bob", {
        aud: "/projects/000/global/backendServices/other"
      })
  },
  {
    name: "an expired assertion",
    assertion: () =>
      actorAssertion("bob", {
        iat: epochSeconds() - 1_200,
        exp: epochSeconds() - 600
      })
  },
  {
    name: "a missing access level",
    assertion: () => actorAssertion("bob", { google: { access_levels: [] } })
  },
  {
    name: "a wrong issuer",
    assertion: () =>
      actorAssertion("bob", { iss: "https://accounts.example.test" })
  },
  {
    name: "an unknown verified subject",
    assertion: () => actorAssertion("bob", { sub: "subject-mallory" })
  }
];

test.setTimeout(120_000);

test("a signed-in employee reaches the portal and its search path", async ({
  browser
}) => {
  const bob = await actorPage(browser, "bob");
  try {
    await bob.page.goto("/");
    await expect(
      bob.page.getByRole("heading", { name: "Find the right manual." })
    ).toBeVisible();
    expect(await search(bob.page, probe)).toBe(200);
    await expect(
      bob.page.getByText("No matching manuals found.")
    ).toBeVisible();
    const capture = bob.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/intake" &&
        response.request().method() === "POST"
    );
    await bob.page.goto("/intake");
    await bob.page.getByLabel("Manual file").setInputFiles({
      name: "sso-probe.pdf",
      mimeType: "application/pdf",
      buffer: textPdf(`${probe} sign-in probe`)
    });
    await bob.page.getByRole("button", { name: "Upload manual" }).click();
    expect((await capture).status()).toBeLessThan(400);
  } finally {
    await bob.context.close();
  }
});

test("an explicit well-formed assertion is accepted by the production verifier", async ({
  browser
}) => {
  const session = await assertionPage(browser, actorAssertion("bob"));
  try {
    expect(await search(session.page, probe)).toBe(200);
    await expect(
      session.page.getByText("No matching manuals found.")
    ).toBeVisible();
  } finally {
    await session.context.close();
  }
});

test("no credential is denied at every portal path", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await expectSearchDenied(page, probe);
    const denied = await page.goto("/documents/doc/versions/version");
    expect(denied?.status()).not.toBe(200);
  } finally {
    await context.close();
  }
});

test("a browser-supplied IAP header is ignored, not trusted", async ({
  browser
}) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "x-goog-iap-jwt-assertion": actorAssertion("bob") }
  });
  const page = await context.newPage();
  try {
    await expectSearchDenied(page, probe);
  } finally {
    await context.close();
  }
});

for (const scenario of denied) {
  test(`${scenario.name} is denied at the browser boundary`, async ({
    browser
  }) => {
    const session = await assertionPage(browser, scenario.assertion());
    try {
      await expectSearchDenied(session.page, probe);
      const download = await session.page.goto(
        "/documents/doc/versions/version"
      );
      expect(download?.status()).not.toBe(200);
    } finally {
      await session.context.close();
    }
  });
}

test("a well-formed assertion for a revoked user is denied until restored", async ({
  browser,
  request
}) => {
  const bob = await actorPage(browser, "bob");
  try {
    expect(await search(bob.page, probe)).toBe(200);
    expect(
      (await request.post(`${e2eGateway}/__e2e/revoke/bob`)).ok()
    ).toBeTruthy();
    await expectSearchDenied(bob.page, probe);
    expect(
      (await request.post(`${e2eGateway}/__e2e/restore/bob`)).ok()
    ).toBeTruthy();
    await expect
      .poll(() => search(bob.page, probe), { timeout: 30_000 })
      .toBe(200);
  } finally {
    await request.post(`${e2eGateway}/__e2e/restore/bob`);
    await request.post(`${e2eGateway}/__e2e/cleanup`);
    await bob.context.close();
  }
});

test("the synthetic verifier itself only accepts the harness signature", async () => {
  const { syntheticIapVerifier } = await import("./harness/assertion");
  const valid = await syntheticIapVerifier.verifyIapToken(
    actorAssertion("bob"),
    ""
  );
  expect(valid).toMatchObject({
    iss: SYNTHETIC_IAP_ISSUER,
    google: { access_levels: [SYNTHETIC_ACCESS_LEVEL] }
  });
  expect(
    await syntheticIapVerifier.verifyIapToken(denied[0]!.assertion(), "")
  ).toEqual({});
});
