import { lingui } from "@lingui/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type PluginOption } from "vite";
import babelMacros from "vite-plugin-babel-macros";
import { configDefaults } from "vitest/config";

export default defineConfig({
  // Same macro pipeline as ERP/MES: babel-plugin-macros transforms
  // `@lingui/react/macro`, and the Lingui plugin loads compiled catalogs.
  plugins: [babelMacros(), lingui(), reactRouter()] as PluginOption[],
  test: { exclude: [...configDefaults.exclude, "tests/**/*.spec.ts"] },
  server: { host: "127.0.0.1", port: 4200, strictPort: true },
  ssr: { noExternal: ["base64-js", "safe-buffer"] }
});
