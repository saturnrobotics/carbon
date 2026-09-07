/** Dev-only live evaluation: real runtime environment and production macro transforms. */

import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import babelMacros from "vite-plugin-babel-macros";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [babelMacros(), lingui()],
  resolve: {
    tsconfigPaths: true,
    alias: { canvas: path.resolve("app/ssr-shims/canvas-stub.cjs") }
  },
  test: {
    include: ["app/modules/invoicing/invoice-intake.live.test.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
});
