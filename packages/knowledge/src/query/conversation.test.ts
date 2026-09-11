import { describe, expect, it } from "vitest";
import {
  type ConversationState,
  reauthorizeConversationState
} from "./conversation";

const principal = {
  companyId: "company-a",
  actorId: "alice",
  policyVersion: "policy-2"
};
const stored: ConversationState = {
  schema: 1,
  companyId: "company-a",
  actorId: "alice",
  policyVersion: "policy-1",
  evidenceIds: ["chunk-1", "chunk-2", "chunk-1"]
};

describe("conversation restore re-authorizes evidence references", () => {
  it("restores only the references the current policy still allows, whole or not at all", async () => {
    const seen: string[][] = [];
    const restored = await reauthorizeConversationState(
      stored,
      principal,
      async (ids) => {
        seen.push([...ids]);
        return true;
      }
    );
    expect(restored).toEqual({
      ...stored,
      evidenceIds: ["chunk-1", "chunk-2"],
      policyVersion: "policy-2"
    });
    expect(seen).toEqual([["chunk-1", "chunk-2"]]);
    expect(
      await reauthorizeConversationState(stored, principal, async () => false)
    ).toBeNull();
  });
  it("fails closed when the policy check is unavailable", async () => {
    await expect(
      reauthorizeConversationState(stored, principal, async () => {
        throw new Error("policy store unavailable");
      })
    ).resolves.toBeNull();
  });
  it("never restores another actor's or company's context", async () => {
    let asked = 0;
    const authorize = async () => {
      asked += 1;
      return true;
    };
    expect(
      await reauthorizeConversationState(
        stored,
        { ...principal, actorId: "bob" },
        authorize
      )
    ).toBeNull();
    expect(
      await reauthorizeConversationState(
        stored,
        { ...principal, companyId: "company-b" },
        authorize
      )
    ).toBeNull();
    expect(asked).toBe(0);
  });
  it("discards malformed state and evidence bodies", async () => {
    const authorize = async () => true;
    expect(
      await reauthorizeConversationState(
        { ...stored, evidence: [{ excerpt: "private text" }] },
        principal,
        authorize
      )
    ).toBeNull();
    expect(
      await reauthorizeConversationState(
        {
          ...stored,
          evidenceIds: Array.from({ length: 9 }, (_, i) => `c${i}`)
        },
        principal,
        authorize
      )
    ).toBeNull();
    expect(
      await reauthorizeConversationState("{}", principal, authorize)
    ).toBeNull();
    expect(
      await reauthorizeConversationState(
        { ...stored, evidenceIds: [] },
        principal,
        async () => false
      )
    ).toEqual({ ...stored, evidenceIds: [], policyVersion: "policy-2" });
  });
});
