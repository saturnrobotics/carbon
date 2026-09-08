import { describe, expect, it } from "vitest";
import { parserInvocation, textParserOutput } from "./parser-job";

describe("isolated parser job", () => {
  it("uses fixed local PDF and image parser binaries without runtime credentials", () => {
    expect(parserInvocation("application/pdf")).toEqual({
      command: "/usr/bin/pdftotext",
      args: ["-layout", "-", "-"]
    });
    expect(parserInvocation("image/png")).toEqual({
      command: "/usr/bin/tesseract",
      args: ["stdin", "stdout"]
    });
    expect(() => parserInvocation("application/zip")).toThrow("unsupported");
  });

  it("turns page-delimited text into bounded citable evidence", () => {
    const parsed = textParserOutput("First page\fSecond page", "manual.pdf");
    expect(parsed.fields.title).toBe("manual.pdf");
    expect(parsed.evidence.body).toEqual([
      { page: 1, text: "First page" },
      { page: 2, text: "Second page" }
    ]);
  });
});
