import { describe, expect, it } from "vitest";
import {
  displayField,
  manualMetadataSchema,
  unresolvedNamesFor
} from "./intake.models";

describe("displayField", () => {
  it("seeds an input from the typed proposal under the parser's name", () => {
    expect(
      displayField(
        {
          id: "i",
          state: "needs-review",
          title: "x",
          proposed: {},
          corrected: {},
          proposedFields: {
            mpn: { value: "MTR-100", confidence: 0.9, evidence: [] }
          },
          unresolved: [],
          sourcePages: []
        },
        "partNumber"
      )
    ).toBe("MTR-100");
  });

  it("maps an input to every name it may carry in unresolved", () => {
    expect(unresolvedNamesFor("partNumber")).toEqual(["partNumber", "mpn"]);
    expect(unresolvedNamesFor("title")).toEqual(["title"]);
    expect(unresolvedNamesFor("machine")).toEqual(["machine"]);
  });

  it("keeps a saved correction visible over a new proposal", () => {
    expect(
      displayField(
        {
          id: "i",
          state: "needs-review",
          title: "x",
          proposed: { mpn: "parser" },
          corrected: { mpn: "reviewed" },
          unresolved: ["mpn"],
          sourcePages: []
        },
        "mpn"
      )
    ).toBe("reviewed");
  });
});

describe("manual metadata", () => {
  it("accepts only the five bounded review fields", () => {
    expect(
      manualMetadataSchema.parse({
        title: "Pump manual",
        manufacturer: "Example Manufacturing",
        partNumber: "P-100",
        revision: "A",
        machine: "Assembly cell"
      })
    ).toMatchObject({ partNumber: "P-100" });
    expect(() =>
      manualMetadataSchema.parse({
        title: "Pump manual",
        manufacturer: "",
        partNumber: "",
        revision: "",
        machine: "",
        arbitrary: "rejected"
      })
    ).toThrow();
  });
});
