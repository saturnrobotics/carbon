import { describe, expect, it } from "vitest";
import { displayField, manualMetadataSchema } from "./intake.models";

describe("displayField", () => {
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
