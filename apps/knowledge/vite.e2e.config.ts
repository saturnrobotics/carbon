/** Test-only Vite configuration. It aliases only the server identity boundary to
 * the loopback synthetic fixture and serves a self-signed HTTPS origin. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin } from "vite";

const appDirectory = dirname(fileURLToPath(import.meta.url));
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
          request.headers.origin = "https://localhost:4200";
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [loopbackIdentityOnly(), reactRouter()],
  server: {
    // React Router's Vite forwarded-action adapter labels a same-origin
    // progressive form submission `Origin: null`. This test-only transport
    // shim restores the known HTTPS loopback origin before the real action and
    // its production CSRF assertion execute.
    origin: "https://localhost:4200",
    host: process.env.KNOWLEDGE_E2E_DOCKER === "1" ? "0.0.0.0" : "127.0.0.1",
    port: 4200,
    strictPort: true,
    https: {
      key: readFileSync(resolve(appDirectory, "tests/harness/.cert/key.pem")),
      cert: readFileSync(resolve(appDirectory, "tests/harness/.cert/cert.pem"))
    }
  },
  ssr: { noExternal: ["base64-js", "safe-buffer"] }
});
