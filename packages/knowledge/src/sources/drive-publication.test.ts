import { describe, expect, it } from "vitest";
import { buildDrivePublicationChunks } from "./drive-publication.server";

describe("Drive publication", () => {
  it("creates bounded citable lexical chunks from parser evidence", () => {
    expect(
      buildDrivePublicationChunks({
        fields: { title: "Manual" },
        evidence: {
          body: [{ page: 2, text: "Torque to 10 N m", region: "table-1" }],
          empty: [{ page: 3, text: "  " }]
        },
        unresolved: [],
        warnings: []
      })
    ).toEqual([
      {
        ordinal: 0,
        page: 2,
        text: "Torque to 10 N m",
        heading: "body",
        bounds: { region: "table-1" },
        tokenCount: 4
      }
    ]);
  });
});
