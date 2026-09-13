import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/parser-job.ts", "src/retention-job.ts"],
  format: ["esm"],
  noExternal: ["@carbon/portal"],
  splitting: false,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
  }
});
