/** Test-only Vite configuration. It aliases only the server identity boundary to
 * the loopback synthetic fixture and serves a self-signed HTTPS origin. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lingui } from "@lingui/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import babelMacros from "vite-plugin-babel-macros";

const appDirectory = dirname(fileURLToPath(import.meta.url));

/** The loopback port this harness serves on. Configurable so a second harness
 * can run beside a long-lived one; loopback-only either way. */
const port = Number(process.env.KNOWLEDGE_E2E_PORT ?? "4200");
if (!Number.isInteger(port) || port < 1024 || port > 65_535)
  throw new Error("KNOWLEDGE_E2E_PORT must be an unprivileged port");
const browserOrigin = new URL(
  process.env.KNOWLEDGE_WEB_ORIGIN ?? `https://localhost:${port}`
);
if (
  browserOrigin.protocol !== "https:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(browserOrigin.hostname)
)
  throw new Error("KNOWLEDGE_WEB_ORIGIN must be an HTTPS loopback origin");
const identityModule = resolve(appDirectory, "app/services/identity.server.ts");
const syntheticIdentityModule = resolve(
  appDirectory,
  "tests/harness/identity.server.ts"
);

function loopbackIdentityOnly(): Plugin {
  return {
    name: "knowledge-e2e-loopback-identity-only",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return null;
      const candidate = resolve(dirname(importer.split("?")[0]!), source);
      if (
        candidate === identityModule ||
        `${candidate}.ts` === identityModule
      ) {
        return syntheticIdentityModule;
      }
      return null;
    },
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.headers.origin === "null") {
          request.headers.origin = browserOrigin.origin;
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [
    loopbackIdentityOnly(),
    babelMacros(),
    lingui(),
    reactRouter()
  ] as PluginOption[],
  server: {
    // React Router's Vite forwarded-action adapter labels a same-origin
    // progressive form submission `Origin: null`. This test-only transport
    // shim restores the known HTTPS loopback origin before the real action and
    // its production CSRF assertion execute.
    origin: browserOrigin.origin,
    host: process.env.KNOWLEDGE_E2E_DOCKER === "1" ? "0.0.0.0" : "127.0.0.1",
    port,
    strictPort: true,
    https: {
      key: readFileSync(resolve(appDirectory, "tests/harness/.cert/key.pem")),
      cert: readFileSync(resolve(appDirectory, "tests/harness/.cert/cert.pem"))
    }
  },
  ssr: { noExternal: ["base64-js", "safe-buffer"] }
});
