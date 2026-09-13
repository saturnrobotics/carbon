/**
 * Browser-boundary checks for the deferred ticket command surface.
 *
 * The manual-v1 release keeps ticket commands deferred, and the shipped shape
 * of that deferral is ROUTE ABSENCE, not a registered route that refuses.
 * `apps/portal/app/routes.ts` is the production route manifest and names
 * none of `api.commands`, `api.propose-command` or `api.transcribe`;
 * `test_production_web_route_manifest_excludes_deferred_routes` in
 * `contrib/deploying/portal/test_images.py` pins that. A React Router route
 * manifest is a BUILD-time artifact, so the request reaches the catch-all
 * (`routes/unavailable.tsx`) in every built image, and no runtime environment
 * can re-open it.
 *
 * `api.commands.ts`'s own `action` still refuses with 503
 * `ticket_commands_not_configured` when the actions service is unconfigured.
 * That refusal belongs to a release profile that REGISTERS the route, which
 * manual-v1 does not, so it cannot be reached here — it is covered directly by
 * `app/routes/api.commands.test.ts`. Asserting it from the browser asserted a
 * response the shipping configuration cannot produce.
 *
 * The full command path (typed or transcribed request → proposal → action
 * service → Kanban receipt) is proven at the service boundary by
 * `apps/portal-actions/src/ticket.kanban.integration.test.ts` and the Kanban
 * backend suite; the origin and shape guards of the route handler are pinned by
 * `app/routes/api.commands.test.ts`.
 */
import { ticketCommandPayloadHash } from "@carbon/portal/commands/ticket";
import { expect, test } from "@playwright/test";
import { actorPage } from "./harness/browser";

const payload = {
  boardId: "board:machine-build",
  initialColumnId: "column:pending",
  title: "Surface grind the spindle housing",
  description: "Grind to drawing tolerance before assembly.",
  dueDate: "2026-09-14",
  businessTimezone: "America/New_York"
};

const proposal = {
  id: "command:e2e",
  version: 1,
  action: "kanban.ticket.create",
  target: { sourceId: "kanban:example", resourceId: payload.boardId },
  payload,
  payloadHash: ticketCommandPayloadHash(payload),
  idempotencyKey: `e2e-${crypto.randomUUID()}`
};

test("the portal offers manual search only; no command affordance is rendered", async ({
  browser
}) => {
  const { context, page } = await actorPage(browser, "bob");
  try {
    await page.goto("/");
    await expect(page.getByLabel("Search manuals")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /record|ticket|command/i })
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the deferred command routes are absent from the manual release, so the catch-all refuses every request", async ({
  browser
}) => {
  const { context, page } = await actorPage(browser, "bob");
  try {
    await page.goto("/");
    const origin = new URL(page.url()).origin;
    const attempts = [
      // A well-formed, same-origin, signed-in proposal.
      { path: "/api/commands", headers: { origin }, data: proposal },
      // A retrieved answer that merely contains a command as text.
      {
        path: "/api/commands",
        headers: { origin },
        data: {
          kind: "answer",
          claims: [{ text: JSON.stringify(proposal), evidenceIds: [] }],
          evidence: []
        }
      },
      // A foreign origin.
      {
        path: "/api/commands",
        headers: { origin: "https://elsewhere.example.test" },
        data: proposal
      },
      // The two routes that would have to produce a proposal in the first
      // place are deferred by the same manifest, so the whole surface is
      // missing rather than only its final gateway.
      { path: "/api/propose-command", headers: { origin }, data: proposal },
      { path: "/api/transcribe", headers: { origin }, data: proposal }
    ];
    for (const attempt of attempts) {
      const response = await page.request.post(attempt.path, {
        headers: { ...attempt.headers, "content-type": "application/json" },
        data: attempt.data
      });
      // Every shape gets the SAME refusal, because nothing shaped it: the
      // request never reached a command handler.
      expect(response.status(), `${attempt.path} must not be routed`).toBe(404);
      expect(response.headers()["content-type"]).toContain("text/html");
      const body = await response.text();
      // Neither the in-app refusal nor any echo of the proposal.
      expect(body).not.toContain("ticket_commands_not_configured");
      expect(body).not.toContain("kanban.ticket.create");
    }
    // The manual surface IS routed, so the 404s above are route absence and
    // not a portal that refuses every POST.
    const routed = await page.request.post("/api/query", {
      headers: { origin, "content-type": "application/json" },
      data: {}
    });
    expect(routed.status()).toBe(422);
  } finally {
    await context.close();
  }
});
