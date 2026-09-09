import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findUnsafeTranslations } from "./helpers/localization";

const appRoot = path.resolve(__dirname, "../app");
const allowedExtensions = new Set([".ts", ".tsx"]);
const excludedSegments = [
  ".server.",
  ".test.",
  ".spec.",
  `${path.sep}locales${path.sep}`
];

function collectFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }

    if (!allowedExtensions.has(path.extname(fullPath))) {
      continue;
    }

    if (excludedSegments.some((segment) => fullPath.includes(segment))) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

describe("Lingui React runtime", () => {
  const files = collectFiles(appRoot).map((file) =>
    path.relative(appRoot, file)
  );

  it("discovers React-facing application source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Give each source file the normal test deadline as the app corpus grows.
  // Every selected file still runs through the complete AST-based check.
  it.each(
    files
  )("%s avoids the unactivated global translation runtime", (relativePath) => {
    const source = readFileSync(path.join(appRoot, relativePath), "utf8");
    expect(findUnsafeTranslations(source)).toEqual([]);
  });
});
