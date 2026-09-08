import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureImmutableUpload, readImmutableObject } from "./gcs";

describe("readImmutableObject", () => {
  it("pins the captured generation and verifies the captured content hash", async () => {
    const bytes = Buffer.from("manual");
    let generation = "";
    const storage = {
      bucket: () => ({
        file: (_key: string, options: { generation: string }) => {
          generation = options.generation;
          return {
            getMetadata: async () => [{ size: String(bytes.length) }],
            download: async () => [bytes]
          };
        }
      })
    };
    await expect(
      readImmutableObject(
        {
          bucket: "private",
          objectKey: "a",
          generation: "42",
          sha256: createHash("sha256").update(bytes).digest("hex")
        },
        storage as never
      )
    ).resolves.toEqual(bytes);
    expect(generation).toBe("42");
  });

  it("captures the storage-assigned generation and content hash", async () => {
    const bytes = Buffer.from("manual");
    const saved: unknown[] = [];
    const storage = {
      bucket: () => ({
        file: () => ({
          save: async (_bytes: Buffer, options: unknown) => {
            saved.push(options);
          },
          getMetadata: async () => [
            { generation: "84", size: String(bytes.length) }
          ],
          download: async () => [bytes]
        })
      })
    };
    const captured = await captureImmutableUpload(
      {
        bucket: "private",
        objectKey: "intake/manual",
        bytes,
        mimeType: "application/pdf"
      },
      storage as never
    );
    expect(captured).toMatchObject({
      generation: "84",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: 6
    });
    expect(saved[0]).toMatchObject({
      preconditionOpts: { ifGenerationMatch: 0 }
    });
  });
});
