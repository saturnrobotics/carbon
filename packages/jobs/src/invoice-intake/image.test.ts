import { createRequire } from "node:module";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { validateInvoiceImage } from "./image";

const require = createRequire(import.meta.url);
const { createCanvas } = createRequire(
  require.resolve("pdfjs-dist/package.json")
)("@napi-rs/canvas");

describe("invoice image preflight", () => {
  it.each([
    "png",
    "jpeg",
    "webp"
  ])("decodes actual %s pixels and rejects a truncated body", async (format) => {
    const canvas = createCanvas(2, 2);
    const encoded = canvas.toBuffer(`image/${format}`);
    await expect(
      validateInvoiceImage(encoded, `image/${format}`)
    ).resolves.toBeUndefined();
    await expect(
      validateInvoiceImage(
        encoded.subarray(0, Math.min(35, encoded.length - 8)),
        `image/${format}`
      )
    ).rejects.toThrow("invoice_image_invalid");
  });
  it("isolates malformed compressed pixels from the application process", async () => {
    const encoded = createCanvas(2, 2).toBuffer("image/png");
    const idat = encoded.indexOf(Buffer.from("IDAT"));
    const length = encoded.readUInt32BE(idat - 4);
    encoded.fill(0, idat + 4, idat + 4 + length);
    encoded.writeUInt32BE(
      crc32(encoded.subarray(idat, idat + 4 + length)),
      idat + 4 + length
    );
    await expect(validateInvoiceImage(encoded, "image/png")).rejects.toThrow(
      "invoice_image_invalid"
    );
    await expect(
      validateInvoiceImage(
        createCanvas(2, 2).toBuffer("image/png"),
        "image/png"
      )
    ).resolves.toBeUndefined();
  }, 10000);
  it("rejects oversized dimensions before native allocation", async () => {
    const encoded = createCanvas(2, 2).toBuffer("image/png");
    encoded.writeUInt32BE(100_000, 16);
    encoded.writeUInt32BE(100_000, 20);
    encoded.writeUInt32BE(crc32(encoded.subarray(12, 29)), 29);
    await expect(validateInvoiceImage(encoded, "image/png")).rejects.toThrow(
      "invoice_image_dimensions_invalid"
    );
  });
});
