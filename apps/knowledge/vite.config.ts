import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [reactRouter()],
  test: { exclude: [...configDefaults.exclude, "tests/**/*.spec.ts"] },
  server: { host: "127.0.0.1", port: 4200, strictPort: true },
  ssr: { noExternal: ["base64-js", "safe-buffer"] }
});
