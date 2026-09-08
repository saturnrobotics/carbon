import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { action as reviewAction } from "../routes/intake.$id";
import { IntakeReview } from "./intake/ui/IntakeReview";
import { IntakeUpload } from "./intake/ui/IntakeUpload";
import { EvidenceCard } from "./portal/ui/EvidenceCard";
import { QueryInput } from "./portal/ui/QueryInput";

describe("manual-v1 portal", () => {
  it("uses one friendly configured source without browser-entered IDs", () => {
    const markup = renderToStaticMarkup(
      <IntakeUpload sourceDisplayName="Operations manuals" />
    );
    expect(markup).toContain("Manual file");
    expect(markup).toContain("Operations manuals");
    expect(markup).not.toContain("Source URL");
    expect(markup).not.toContain('name="sourceId"');
  });

  it("renders only the five fixed review fields", () => {
    const markup = renderToStaticMarkup(
      <IntakeReview
        model={{
          id: "intake-synthetic",
          state: "needs-review",
          title: "Captured manual",
          proposed: { title: "Manual", arbitrary: "must not render" },
          corrected: {},
          unresolved: [],
          sourcePages: []
        }}
      />
    );
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
  });

  it("advertises keyword manual search without deferred features", () => {
    const markup = renderToStaticMarkup(
      <QueryInput sourceDisplayName="Operations manuals" />
    );
    expect(markup).toContain("Search manuals");
    expect(markup).toContain("Upload a manual");
    expect(markup).not.toMatch(/voice|ticket|command/i);
  });

  it("offers explicit download and removal from a manual result", () => {
    const markup = renderToStaticMarkup(
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

  it("rejects malformed review metadata as a client error", async () => {
    const form = new FormData();
    form.set("intent", "review");
    form.set("expectedGeneration", "1");
    form.set("expectedVersion", "1");
    form.set("metadata", "{");
    const request = new Request(
      "https://portal.example/intake/intake-synthetic",
      {
        method: "POST",
        body: form
      }
    );

    await expect(
      reviewAction({ request, params: { id: "intake-synthetic" } })
    ).rejects.toMatchObject({ status: 422 });
  });
});
