import { describe, expect, it } from "vitest";
import { validateManualFile } from "./manual-file";

describe("manual file boundary", () => {
  it("accepts only supported MIME types with matching file signatures", () => {
    expect(() =>
      validateManualFile("application/pdf", Buffer.from("%PDF-1.4\n"))
    ).not.toThrow();
    expect(() =>
      validateManualFile(
        "image/png",
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      )
    ).not.toThrow();
    expect(() =>
      validateManualFile("image/jpeg", Buffer.from([255, 216, 255, 224]))
    ).not.toThrow();
    expect(() =>
      validateManualFile("image/tiff", Buffer.from([73, 73, 42, 0]))
    ).not.toThrow();
  });
  it("rejects active SVG and spoofed raster/PDF uploads before object storage", () => {
    for (const mime of [
      "image/svg+xml",
      "image/png",
      "application/pdf",
      "text/html"
    ]) {
      expect(() =>
        validateManualFile(mime, Buffer.from('<svg onload="alert(1)"/>'))
      ).toThrow();
    }
  });
});
