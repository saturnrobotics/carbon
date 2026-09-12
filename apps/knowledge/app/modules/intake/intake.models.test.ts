import { describe, expect, it } from "vitest";
import {
  displayField,
  intakeReviewModel,
  manualMetadataSchema,
  reviewSubmissionSchema
} from "./intake.models";

const base = {
  id: "i",
  state: "needs-review" as const,
  published: false,
  title: "x",
  proposed: {},
  corrected: {},
  unresolved: [],
  evidence: [],
  item: null,
  itemDecided: false
};

describe("displayField", () => {
  it("keeps a saved correction visible over a new proposal", () => {
    expect(
      displayField(
        {
          ...base,
          proposed: { mpn: "parser" },
          corrected: { mpn: "reviewed" },
          unresolved: ["mpn"]
        },
        "mpn"
      )
    ).toBe("reviewed");
  });
});

describe("intakeReviewModel", () => {
  it("shapes the worker record with page-anchored evidence and provenance", () => {
    const model = intakeReviewModel({
      intake: {
        id: "intake-1",
        version: 3,
        generation: "2",
        state: "ready",
        inputRefs: [
          { kind: "object", acquiredFrom: "https://manuals.example/p.pdf" }
        ],
        extraction: { title: "Pump manual", partNumber: "P-100", stray: 1 },
        extractionOutput: {
          evidence: {
            title: [{ page: 1, text: "Pump manual", region: "header" }],
            manual: [
              { page: 2, text: "Procedure" },
              { page: "x", text: "bad" }
            ]
          }
        },
        reviewDecisions: {
          title: { value: "Pump manual rev A", decision: "corrected" },
          item: {
            value: {
              id: "item-1",
              readableId: "P-100",
              name: "Pump",
              revision: "A",
              mpn: null
            },
            decision: "corrected"
          }
        },
        unresolved: ["partNumber", 7]
      }
    });
    expect(model).toMatchObject({
      id: "intake-1",
      version: "3",
      generation: "2",
      state: "ready",
      published: false,
      title: "Pump manual rev A",
      corrected: { title: "Pump manual rev A" },
      proposed: { title: "Pump manual", partNumber: "P-100" },
      unresolved: ["partNumber"],
      acquiredFrom: "https://manuals.example/p.pdf",
      item: { id: "item-1" },
      itemDecided: true
    });
    expect(model.evidence).toEqual([
      { field: "title", page: 1, text: "Pump manual", region: "header" },
      { field: "manual", page: 2, text: "Procedure" }
    ]);
  });

  it("marks a published review and an undecided item association", () => {
    const model = intakeReviewModel({
      intake: {
        id: "intake-2",
        state: "ready",
        reviewDecisions: { __published: { documentId: "doc" } }
      }
    });
    expect(model.published).toBe(true);
    expect(model.itemDecided).toBe(false);
    expect(model.item).toBeNull();
    expect(intakeReviewModel({}).state).toBe("captured");
  });
});

describe("review submission", () => {
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

  it("carries one bounded item association or an explicit none", () => {
    const metadata = {
      title: "Pump manual",
      manufacturer: "",
      partNumber: "",
      revision: "",
      machine: ""
    };
    expect(reviewSubmissionSchema.parse({ metadata, item: null }).item).toBe(
      null
    );
    expect(
      reviewSubmissionSchema.parse({
        metadata,
        item: {
          id: "item-1",
          readableId: "P-100",
          name: "Pump",
          revision: null,
          mpn: null
        }
      }).item
    ).toMatchObject({ id: "item-1" });
    expect(() =>
      reviewSubmissionSchema.parse({
        metadata,
        item: { id: "item-1", sourceId: "leaked" }
      })
    ).toThrow();
  });
});
