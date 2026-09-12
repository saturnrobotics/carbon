import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TTL_SECONDS,
  createConversationStore
} from "./conversation.server";

const alice = { companyId: "company-a", actorId: "alice", policyVersion: "p1" };
const bob = { companyId: "company-a", actorId: "bob", policyVersion: "p1" };

function memoryStore() {
  const values = new Map<string, { value: unknown; ttl: number }>();
  return {
    values,
    store: {
      get: async (key: string) => values.get(key)?.value,
      set: async (key: string, value: unknown, ttl: number) => {
        values.set(key, { value, ttl });
      }
    }
  };
}

describe("conversation store", () => {
  it("stores evidence ids only, under the verified principal, for the follow-up window", async () => {
    const memory = memoryStore();
    const conversations = createConversationStore(memory.store);
    await conversations.save(alice, "conversation-1", [
      "chunk-a",
      "chunk-b",
      "chunk-a"
    ]);
    expect(memory.values.size).toBe(1);
    const [entry] = [...memory.values.values()];
    expect(entry?.ttl).toBe(CONVERSATION_TTL_SECONDS);
    expect(entry?.value).toEqual({
      schema: 1,
      companyId: "company-a",
      actorId: "alice",
      policyVersion: "p1",
      evidenceIds: ["chunk-a", "chunk-b"]
    });
    expect(JSON.stringify(entry?.value)).not.toMatch(/excerpt|text|title/);
  });
  it("re-authorizes every reference on reuse and restores nothing otherwise", async () => {
    const memory = memoryStore();
    const conversations = createConversationStore(memory.store);
    await conversations.save(alice, "conversation-1", ["chunk-a", "chunk-b"]);
    const seen: string[][] = [];
    const restored = await conversations.load(
      { ...alice, policyVersion: "p2" },
      "conversation-1",
      async (ids) => {
        seen.push([...ids]);
        return true;
      }
    );
    expect(restored).toMatchObject({
      evidenceIds: ["chunk-a", "chunk-b"],
      policyVersion: "p2"
    });
    expect(seen).toEqual([["chunk-a", "chunk-b"]]);
    expect(
      await conversations.load(alice, "conversation-1", async () => false)
    ).toBeNull();
    expect(
      await conversations.load(alice, "conversation-1", async () => {
        throw new Error("policy store down");
      })
    ).toBeNull();
  });
  it("gives another actor nothing for the same conversation id", async () => {
    const memory = memoryStore();
    const conversations = createConversationStore(memory.store);
    await conversations.save(alice, "conversation-1", ["chunk-a"]);
    let asked = false;
    expect(
      await conversations.load(bob, "conversation-1", async () => {
        asked = true;
        return true;
      })
    ).toBeNull();
    expect(asked).toBe(false);
  });
  it("treats a failing store as no context and never fails a delivery", async () => {
    const failing = createConversationStore({
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      }
    });
    await expect(
      failing.save(alice, "conversation-1", ["chunk-a"])
    ).resolves.toBeUndefined();
    expect(
      await failing.load(alice, "conversation-1", async () => true)
    ).toBeNull();
  });
});
