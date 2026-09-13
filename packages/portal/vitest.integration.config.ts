import baseConfig from "@carbon/config/vitest";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["src/**/*.integration.test.ts"],
      passWithNoTests: false,
      fileParallelism: false,
      testTimeout: 120_000
    }
  })
);
