import { describe, expect, it } from "vitest";
import {
  looksLikeContentHash,
  proposedTitle,
  titleFromFirstPage,
  titleFromName
} from "./document-title";

const SHA256 =
  "3b1f2c9d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c";

describe("looksLikeContentHash", () => {
  it("recognizes the digest shapes an object key can carry", () => {
    expect(looksLikeContentHash(SHA256)).toBe(true);
    expect(looksLikeContentHash(SHA256.toUpperCase())).toBe(true);
    expect(
      looksLikeContentHash("da39a3ee5e6b4b0d3255bfef95601890afd80709")
    ).toBe(true);
    expect(looksLikeContentHash("d41d8cd98f00b204e9800998ecf8427e")).toBe(true);
  });

  it("leaves a short hexadecimal word that is really a title alone", () => {
    expect(looksLikeContentHash("Deadbeef assembly")).toBe(false);
    expect(looksLikeContentHash("ACME-1200")).toBe(false);
    expect(looksLikeContentHash("Bench press manual")).toBe(false);
  });
});

describe("titleFromName", () => {
  it("drops the extension and keeps the name the uploader chose", () => {
    expect(titleFromName("saturn-bench-press-manual.pdf")).toBe(
      "saturn-bench-press-manual"
    );
    expect(titleFromName("ACME-1200.PDF")).toBe("ACME-1200");
    expect(titleFromName("Pump service guide.pdf")).toBe("Pump service guide");
  });

  it("keeps a name that has no extension to drop", () => {
    expect(titleFromName("Bench press manual")).toBe("Bench press manual");
  });

  it("takes the final segment of a path or an acquisition URL", () => {
    expect(titleFromName("C:\\scans\\pump-manual.pdf")).toBe("pump-manual");
    expect(titleFromName("https://example.com/docs/pump%20manual.pdf")).toBe(
      "pump manual"
    );
    expect(titleFromName("https://example.com/docs/")).toBe("docs");
  });

  it("collapses whitespace and control characters into one readable line", () => {
    expect(titleFromName("  pump\tservice\nguide .pdf ")).toBe(
      "pump service guide"
    );
  });

  it("refuses a hash-shaped name rather than proposing it", () => {
    expect(titleFromName(`${SHA256}.pdf`)).toBeUndefined();
    expect(titleFromName(`intake/company/user/${SHA256}`)).toBeUndefined();
    expect(
      titleFromName(`https://example.com/objects/${SHA256}`)
    ).toBeUndefined();
  });

  it("refuses a name with nothing readable in it", () => {
    expect(titleFromName(undefined)).toBeUndefined();
    expect(titleFromName("")).toBeUndefined();
    expect(titleFromName("   ")).toBeUndefined();
    expect(titleFromName("2024.pdf")).toBeUndefined();
    expect(titleFromName("---.pdf")).toBeUndefined();
    expect(titleFromName("https://example.com")).toBeUndefined();
  });
});

describe("titleFromFirstPage", () => {
  it("takes the first heading line of page one", () => {
    expect(
      titleFromFirstPage("Bench Press Service Manual\nModel 1200\fPage two")
    ).toBe("Bench Press Service Manual");
  });

  it("skips page furniture ahead of the heading", () => {
    expect(
      titleFromFirstPage(
        "Page 1 of 42\n-------------------------\nBench Press Service Manual\n"
      )
    ).toBe("Bench Press Service Manual");
    expect(
      titleFromFirstPage("https://example.com/manuals\nHydraulic Press Manual")
    ).toBe("Hydraulic Press Manual");
    expect(
      titleFromFirstPage("© 2026 Example Corp\nHydraulic Press Manual")
    ).toBe("Hydraulic Press Manual");
  });

  it("never reaches past the opening lines for a heading", () => {
    const page = ["1", "2", "3", "4", "5", "Bench Press Manual"].join("\n");
    expect(titleFromFirstPage(page)).toBeUndefined();
  });

  it("proposes nothing when page one has no heading", () => {
    expect(titleFromFirstPage("")).toBeUndefined();
    expect(titleFromFirstPage("   \n\n  ")).toBeUndefined();
    expect(titleFromFirstPage("12 34 56 78\n90 12")).toBeUndefined();
    expect(titleFromFirstPage(SHA256)).toBeUndefined();
  });

  it("looks only at the first page", () => {
    expect(titleFromFirstPage("\fBench Press Manual")).toBeUndefined();
  });
});

describe("proposedTitle", () => {
  it("prefers the name the uploader chose over a heading guess", () => {
    expect(
      proposedTitle({
        name: "saturn-bench-press-manual.pdf",
        text: "SATURN ROBOTICS\nBench Press"
      })
    ).toEqual({ value: "saturn-bench-press-manual" });
  });

  it("falls back to the first page when the capture was never named", () => {
    expect(
      proposedTitle({ text: "Hydraulic Press Manual\nRevision B" })
    ).toEqual({
      value: "Hydraulic Press Manual",
      evidence: { page: 1, text: "Hydraulic Press Manual" }
    });
  });

  it("falls back to the first page when the name is a content hash", () => {
    expect(
      proposedTitle({
        name: `${SHA256}.pdf`,
        text: "Hydraulic Press Manual\nRevision B"
      })
    ).toEqual({
      value: "Hydraulic Press Manual",
      evidence: { page: 1, text: "Hydraulic Press Manual" }
    });
  });

  it("proposes nothing rather than inventing a title", () => {
    expect(proposedTitle({})).toBeUndefined();
    expect(proposedTitle({ name: SHA256, text: SHA256 })).toBeUndefined();
  });

  it("cites a page only for a title the document itself carries", () => {
    expect(proposedTitle({ name: "manual.pdf" })?.evidence).toBeUndefined();
  });
});
