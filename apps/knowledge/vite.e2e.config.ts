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
// The published port is also the port served inside the container, so the
// browser's `Host`, Vite's asset origin and the app's own origin assertion all
// agree. Unset (CI and the default stack) keeps the historical 4200.
const portalPort = Number(process.env.KNOWLEDGE_E2E_PORTAL_PORT ?? 4200);
if (!Number.isInteger(portalPort) || portalPort < 1 || portalPort > 65535)
  throw new Error("KNOWLEDGE_E2E_PORTAL_PORT must be a TCP port");
const portalOrigin = `https://localhost:${portalPort}`;
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
          request.headers.origin = portalOrigin;
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
    origin: portalOrigin,
    host: process.env.KNOWLEDGE_E2E_DOCKER === "1" ? "0.0.0.0" : "127.0.0.1",
    port: portalPort,
    strictPort: true,
    https: {
      key: readFileSync(resolve(appDirectory, "tests/harness/.cert/key.pem")),
      cert: readFileSync(resolve(appDirectory, "tests/harness/.cert/cert.pem"))
    }
  },
  ssr: { noExternal: ["base64-js", "safe-buffer"] }
});
