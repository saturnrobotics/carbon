import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import babelMacros from "vite-plugin-babel-macros";
import { defineConfig } from "vitest/config";
export default defineConfig({
	plugins: [babelMacros(), lingui()],
	resolve: {
		tsconfigPaths: true,
		alias: { canvas: path.resolve("app/ssr-shims/canvas-stub.cjs") },
	},
	test: {
		include: ["test/invoice-browser/fixture.integration.test.ts"],
		testTimeout: 60000,
		hookTimeout: 60000,
		fileParallelism: false,
	},
});
