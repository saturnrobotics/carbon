## Execute each container's default entrypoint after a successful build

**Context:** A standalone schema job compiled successfully into an ESM container artifact.

**Problem:** Its bundler included a CommonJS database driver without a compatible require bridge, so the image crashed on a Node builtin before reaching the database. Image build success did not establish executable runtime correctness.

**Rule:** Smoke each production container through its default entrypoint, including finite jobs, against an explicitly disposable fixture. Keep runtime dependencies external or use the existing ESM require bridge when bundling CommonJS. Verify the intended deployment architecture separately from the laptop's native architecture.

**Applies to:** Standalone service/job images, tsup bundles and local release validation.
