/**
 * Browser-boundary checks for the explicit ticket command route.
 *
 * The manual-v1 release keeps ticket commands deferred: the portal renders no
 * command affordance and `/api/commands` refuses every request until an
 * actions service is configured. These checks pin that boundary in the real
 * browser stack. The full command path (typed or transcribed request →
 * proposal → action service → Kanban receipt) is proven at the service
 * boundary by `apps/knowledge-actions/src/ticket.kanban.integration.test.ts`
 * and the Kanban backend suite; the origin and shape guards of the route are
 * pinned by `app/routes/api.commands.test.ts`.
 */
import { ticketCommandPayloadHash } from "@carbon/knowledge/commands/ticket";
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

test("the deferred command route refuses every request under the manual release configuration", async ({
  browser
}) => {
  const { context, page } = await actorPage(browser, "bob");
  try {
    await page.goto("/");
    const origin = new URL(page.url()).origin;
    const attempts = [
      // A well-formed, same-origin, signed-in proposal.
      { headers: { origin }, data: proposal },
      // A retrieved answer that merely contains a command as text.
      {
        headers: { origin },
        data: {
          kind: "answer",
          claims: [{ text: JSON.stringify(proposal), evidenceIds: [] }],
          evidence: []
        }
      },
      // A foreign origin.
      { headers: { origin: "https://elsewhere.example.test" }, data: proposal }
    ];
    for (const attempt of attempts) {
      const response = await page.request.post("/api/commands", {
        headers: { ...attempt.headers, "content-type": "application/json" },
        data: attempt.data
      });
      expect(response.status()).toBe(503);
      expect(await response.json()).toEqual({
        error: "ticket_commands_not_configured"
      });
    }
  } finally {
    await context.close();
  }
});
