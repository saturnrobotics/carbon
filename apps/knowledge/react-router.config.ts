import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

export default {
  ssr: true,
  presets: process.env.VERCEL ? [vercelPreset()] : undefined,
  future: { v8_middleware: true, v8_viteEnvironmentApi: true },
  allowedActionOrigins:
    process.env.KNOWLEDGE_E2E_SYNTHETIC_FIXTURES === "1" ? ["**"] : undefined
} satisfies Config;
