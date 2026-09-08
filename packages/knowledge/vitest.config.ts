import baseConfig from "@carbon/config/vitest";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts"],
      exclude: ["src/**/*.integration.test.ts"],
      passWithNoTests: false
    }
  })
);
