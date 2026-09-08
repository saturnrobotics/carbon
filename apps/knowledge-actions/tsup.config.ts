import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts"],
  format: ["esm"],
  noExternal: ["@carbon/knowledge"],
  splitting: false,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
  }
});
