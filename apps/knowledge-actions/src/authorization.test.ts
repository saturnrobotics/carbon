import type { Principal } from "@carbon/knowledge";
import { describe, expect, it } from "vitest";

import {
  assertTicketCommandInvoker,
  TicketCommandAuthorizationError
} from "./authorization";

const human: Principal = {
  kind: "human",
  actorId: "user:1",
  companyId: "company:1",
  callerId: "knowledge-actions",
  sourceIdentity: { issuer: "https://cloud.google.com/iap", subject: "s:1" },
  policyVersion: "policy:1",
  capabilities: ["kanban.ticket.create"]
};

describe("ticket command invocation rights", () => {
  it("admits a workforce identity holding the command capability", () => {
    expect(assertTicketCommandInvoker(human)).toBe(human);
  });

  it("refuses a read-only query identity even though it may search", () => {
    expect(() =>
      assertTicketCommandInvoker({
        ...human,
        capabilities: ["knowledge.read", "knowledge.transcribe"]
      })
    ).toThrow(TicketCommandAuthorizationError);
  });

  it("refuses a machine identity regardless of its capabilities", () => {
    expect(() =>
      assertTicketCommandInvoker({
        kind: "machine",
        companyId: "company:1",
        callerId: "knowledge-worker",
        sourceIds: ["kanban:example"],
        policyVersion: "policy:1",
        capabilities: ["source.changes.read", "source.index.read"]
      })
    ).toThrow(/workforce identity/);
  });
});
