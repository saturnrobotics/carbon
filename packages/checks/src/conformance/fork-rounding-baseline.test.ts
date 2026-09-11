import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyOf, loadBaseline } from "../baseline";
import { repoRoot } from "../sources/migrations";
import { noRawRounding } from "./no-raw-rounding";

// Reviewed integer geometry/calendar calculations and a validated external USD
// contract. These are exact historical sites, never whole-file exemptions.
const reviewedSites = [
  {
    name: "ISO calendar week buckets",
    file: "packages/database/supabase/functions/lib/utils.ts",
    snippet:
      "Math.floor(thursday.compare(new CalendarDate(thursday.year, 1, 1)) / 7) + 1",
    changed:
      "Math.floor(thursday.compare(new CalendarDate(thursday.year, 1, 1)) / 8) + 1"
  },
  {
    name: "PNG Adam7 scanline allocation",
    file: "packages/jobs/src/invoice-intake/image.ts",
    snippet:
      "const rows=passes.map(([x,y,dx,dy])=>[Math.max(0,Math.ceil((width-x)/dx)),Math.max(0,Math.ceil((height-y)/dy))]).filter(([w,h])=>w&&h).map(([w,h])=>[Math.ceil(w*channels*depth/8),h]);",
    changed:
      "const rows=passes.map(([x,y,dx,dy])=>[Math.max(0,Math.ceil((width-x)/dx)),Math.max(0,Math.ceil((height-y)/dy))]).filter(([w,h])=>w&&h).map(([w,h])=>[Math.ceil(w*channels*depth/16),h]);"
  },
  {
    name: "Mercury cent representability check",
    file: "packages/jobs/src/payment-sync/providers.ts",
    snippet: "Math.abs(value * 100 - Math.round(value * 100)) > 0.0001",
    changed: "Math.abs(value * 100 - Math.round(value * 100)) > 1"
  },
  {
    name: "validated Mercury USD wire formatting",
    file: "packages/jobs/src/payment-sync/providers.ts",
    snippet: "return value.toFixed(2);",
    changed: "return value.toFixed(3);"
  }
];

const baseline = loadBaseline();
const unreviewed = (file: string, source: string) =>
  noRawRounding
    .scan(file, source)
    .filter((violation) => !baseline.has(keyOf(noRawRounding.id, violation)));

describe.each(reviewedSites)("fork rounding baseline: $name", ({
  file,
  snippet,
  changed
}) => {
  it("allows only the reviewed occurrence that still exists in real source", () => {
    const findings = noRawRounding.scan(
      file,
      readFileSync(join(repoRoot(), file), "utf8")
    );
    expect(
      findings.filter((finding) => finding.snippet === snippet)
    ).toHaveLength(1);
    expect(unreviewed(file, snippet)).toHaveLength(0);
  });

  it("requires review again when the calculation or wire precision changes", () => {
    expect(changed).not.toBe(snippet);
    expect(unreviewed(file, changed)).toHaveLength(1);
  });

  it("still rejects newly introduced monetary rounding in the same file", () => {
    const added =
      "const unreviewedInvoiceTotal = Math.round(invoiceTotal * 100) / 100;";
    expect(
      unreviewed(file, `${snippet}\n${added}`).map((finding) => finding.snippet)
    ).toEqual([added]);
  });
});
