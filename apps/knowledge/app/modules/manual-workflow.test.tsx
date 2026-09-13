import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { action as reviewAction } from "../routes/intake.$id";
import { LocaleProvider } from "../services/locale";
import type { IntakeReviewModel } from "./intake/intake.models";
import { IntakeReview } from "./intake/ui/IntakeReview";
import { IntakeUpload } from "./intake/ui/IntakeUpload";
import { EvidenceCard } from "./portal/ui/EvidenceCard";
import { QueryInput } from "./portal/ui/QueryInput";

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <LocaleProvider language="en">{node}</LocaleProvider>
  );
}

const reviewModel: IntakeReviewModel = {
  id: "intake-synthetic",
  state: "needs-review",
  published: false,
  title: "Captured manual",
  proposed: { title: "Manual", arbitrary: "must not render" },
  corrected: {},
  unresolved: [],
  evidence: [
    { field: "title", page: 2, text: "Pump manual" },
    { field: "manual", page: 1, text: "Model P-100 revision A" }
  ],
  item: null,
  itemDecided: false
};

describe("manual-v1 portal", () => {
  it("offers file, drop, camera, and URL intake into a writable library", () => {
    const markup = render(
      <IntakeUpload
        actorId="reviewer"
        sources={[
          {
            sourceId: "source-synthetic",
            displayName: "Operations manuals",
            classification: "internal"
          }
        ]}
      />
    );
    expect(markup).toContain("Manual file");
    expect(markup).toContain("Operations manuals");
    expect(markup).toContain('capture="environment"');
    expect(markup).toContain('name="sourceUrl"');
    expect(markup).toContain('name="sourceId"');
    expect(markup).toContain('value="source-synthetic"');
    expect(markup).not.toContain('name="classification"');
    expect(markup).toContain("Drag and drop");
  });

  it("keeps the form when no library is writable and reports it", () => {
    const markup = render(<IntakeUpload actorId="" sources={[]} />);
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('name="sourceId"');
    expect(markup).toContain("Upload manual");
  });

  it("names an acquisition failure apart from extraction", () => {
    const markup = render(
      <IntakeUpload actorId="" sources={[]} error="acquisition_failed" />
    );
    expect(markup).toContain("could not be fetched");
  });

  it("renders the five review fields beside page-anchored evidence", () => {
    const markup = render(<IntakeReview model={reviewModel} />);
    for (const label of [
      "Title",
      "Manufacturer",
      "Part number",
      "Revision",
      "Machine"
    ])
      expect(markup).toContain(label);
    expect(markup).not.toContain("arbitrary");
    expect(markup).toContain("Publish manual");
    expect(markup).toContain('aria-label="Source evidence"');
    expect(markup).toContain("Page 1");
    expect(markup).toContain("Page 2");
    expect(markup).toContain("Page images are not available");
    expect(markup).toContain("No item association");
    expect(markup).toContain('name="item"');
  });

  it("shows a saved correction over a changed proposal without hiding it", () => {
    const markup = render(
      <IntakeReview
        model={{
          ...reviewModel,
          proposed: { title: "Parser title" },
          corrected: { title: "Reviewed title" },
          unresolved: ["title"]
        }}
      />
    );
    expect(markup).toContain('value="Reviewed title"');
    expect(markup).toContain("Proposed: Parser title");
    expect(markup).toContain("I reviewed this evidence");
  });

  it("makes a published review read-only", () => {
    const markup = render(
      <IntakeReview
        model={{ ...reviewModel, state: "ready", published: true }}
      />
    );
    expect(markup).toContain("Published");
    expect(markup).toMatch(/<fieldset[^>]*disabled/);
  });

  it("shows typed proposals with confidence and unit under the fixed labels", () => {
    const markup = render(
      <IntakeReview
        model={{
          ...reviewModel,
          proposed: {},
          proposedFields: {
            mpn: {
              value: "MTR-100",
              confidence: 0.72,
              evidence: [{ page: 3 }]
            },
            documentType: {
              value: "datasheet",
              confidence: 0.9,
              evidence: [{ page: 1 }]
            },
            measurements: {
              ratedVoltage: {
                value: 24,
                unit: "V",
                confidence: 0.4,
                evidence: [{ page: 5 }]
              }
            }
          },
          unresolved: ["mpn", "measurements.ratedVoltage"]
        }}
      />
    );
    expect(markup).toContain('value="MTR-100"');
    expect(markup).toContain("(review, 72% confidence) from page 3");
    expect(markup).toContain("Proposed 24 V (unresolved, 40% confidence)");
    expect(markup).toContain("Proposed datasheet (confident, 90% confidence)");
    expect(markup).toContain('id="partNumber-unresolved"');
    expect(markup).toContain('id="measurements.ratedVoltage-unresolved"');
    expect(markup).not.toContain('id="mpn-unresolved"');
    expect(markup).not.toContain('id="documentType-unresolved"');
  });

  it("advertises keyword manual search without deferred features", () => {
    const markup = render(
      <QueryInput sourceDisplayName="Operations manuals" />
    );
    expect(markup).toContain("Search manuals");
    expect(markup).toContain("Upload a manual");
    expect(markup).not.toMatch(/voice|ticket|command/i);
  });

  it("offers explicit download and removal from a manual result", () => {
    const markup = render(
      <EvidenceCard
        evidence={{
          id: "chunk-synthetic",
          sourceId: "manuals",
          documentVersionId: "version-synthetic",
          sourceRevision: "1",
          title: "Pump manual",
          sourceUri:
            "https://manuals.example/documents/document-synthetic/versions/version-synthetic",
          observedAt: "2026-09-07T00:00:00Z",
          policyVersion: "1",
          freshness: "current"
        }}
        sourceDisplayName="Operations manuals"
      />
    );
    expect(markup).toContain("Download original");
    expect(markup).toContain("Remove manual");
    expect(markup).toContain("/documents/document-synthetic/remove");
  });

  it.each([
    ["malformed metadata", { metadata: "{", item: "null" }],
    ["an unbounded item", { metadata: "{}", item: '{"id":"x","extra":1}' }]
  ])("rejects %s as a client error", async (_name, fields) => {
    const form = new FormData();
    form.set("intent", "review");
    form.set("expectedGeneration", "1");
    form.set("expectedVersion", "1");
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const request = new Request(
      "https://portal.example/intake/intake-synthetic",
      { method: "POST", body: form }
    );
    await expect(
      reviewAction({ request, params: { id: "intake-synthetic" } })
    ).rejects.toMatchObject({ status: 422 });
  });
});
