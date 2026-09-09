import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { corsHeaders } from "../supabase/functions/lib/headers";

const endpoint = "wss://browser.example.com?token=synthetic-thumbnail-test";
const thumbnailSource = readFileSync(
  new URL("../supabase/functions/thumbnail/index.ts", import.meta.url),
  "utf8"
);

async function loadThumbnail(
  configuredEndpoint?: string,
  failure?: "connect" | "newPage" | "close"
) {
  const calls: Array<{ browserWSEndpoint: string }> = [];
  const logs: unknown[] = [];
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const record = (...values: unknown[]) => logs.push(...values);
  const browser = {
    async newPage() {
      if (failure === "newPage")
        throw new Error(`Browser failure: ${endpoint}`);
      return {
        setViewport: async () => undefined,
        goto: async () => null,
        waitForSelector: async () => null,
        async screenshot() {
          return new Uint8Array([1, 2, 3]);
        }
      };
    },
    async close() {
      if (failure === "close") throw new Error(`Close failure: ${endpoint}`);
    }
  };

  // Execute the production serve callback. Only Deno's module imports and
  // external browser/WASM operations are replaced; request handling is intact.
  const parsed = ts.createSourceFile(
    "thumbnail.ts",
    thumbnailSource,
    ts.ScriptTarget.Latest,
    true
  );
  const transformed = ts.transform(parsed, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        if (ts.isImportDeclaration(node)) return undefined;
        if (ts.isMetaProperty(node)) {
          return ts.factory.createIdentifier("testImportMeta");
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit, ts.isSourceFile) ?? node;
    }
  ]);
  let source: string;
  try {
    const transformedFile = transformed.transformed[0];
    assert.ok(transformedFile);
    source = ts.createPrinter().printFile(transformedFile);
  } finally {
    transformed.dispose();
  }
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  });

  await runInNewContext(`(async () => { ${outputText}\n })()`, {
    Buffer,
    URL,
    Response,
    Uint8Array,
    z,
    corsHeaders,
    testImportMeta: { resolve: () => "https://example.com/module.js" },
    Deno: {
      readFile: async () => new Uint8Array(),
      env: {
        get(name: string) {
          assert.equal(name, "BROWSERLESS_WS_URL");
          return configuredEndpoint;
        }
      }
    },
    serve(callback: typeof handler) {
      handler = callback;
    },
    puppeteer: {
      async connect(options: { browserWSEndpoint: string }) {
        calls.push(options);
        if (failure === "connect") {
          throw new Error(`Connection failure: ${endpoint}`);
        }
        return browser;
      }
    },
    getFunctionLogger: () => ({ info: record, debug: record, warn: record }),
    corsPreflight(request: Request) {
      return request.method === "OPTIONS"
        ? new Response("ok", { headers: corsHeaders })
        : null;
    },
    errorResponse(error: unknown, status: number) {
      // Match the shared response helper's relevant contract: it logs the
      // original value and surfaces a non-data-layer error's message.
      record(error);
      const message =
        typeof error === "string"
          ? error
          : (error as { message?: string })?.message;
      return new Response(JSON.stringify({ message }), {
        headers: corsHeaders,
        status
      });
    },
    initializeImageMagick: async () => undefined,
    MagickColor: class {},
    MagickFormat: { Png: "png" },
    ImageMagick: {
      async read(data: Uint8Array, transform: (image: unknown) => Uint8Array) {
        return transform({
          transparent: () => undefined,
          resize: () => undefined,
          write: (callback: (bytes: Uint8Array) => Uint8Array) => callback(data)
        });
      }
    }
  });
  assert.ok(handler, "The production entrypoint must register its handler");
  return { handler, calls, logs };
}

function request(method = "POST") {
  return new Request("https://example.com/thumbnail", {
    method,
    ...(method === "POST"
      ? { body: JSON.stringify({ url: "https://example.com/model" }) }
      : {})
  });
}

for (const configuredEndpoint of [undefined, "", "   "]) {
  test(`missing browser configuration fails before connecting (${configuredEndpoint === undefined ? "unset" : `${configuredEndpoint.length} characters`})`, async () => {
    const fixture = await loadThumbnail(configuredEndpoint);
    const response = await fixture.handler(request());
    assert.equal(fixture.calls.length, 0);
    assert.equal(response.status, 500);
    assert.match(await response.text(), /BROWSERLESS_WS_URL.*configured/);
  });
}

test("OPTIONS succeeds without browser configuration", async () => {
  const fixture = await loadThumbnail();
  const response = await fixture.handler(request("OPTIONS"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(fixture.calls.length, 0);
});

test("configured endpoint is used for thumbnail generation", async () => {
  const fixture = await loadThumbnail(endpoint);
  const response = await fixture.handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0]?.browserWSEndpoint, endpoint);
  assert.deepEqual(
    Array.from(new Uint8Array(await response.arrayBuffer())),
    [1, 2, 3]
  );
});

test("invalid request JSON still reports a payload error before connecting", async () => {
  const fixture = await loadThumbnail(endpoint);
  const response = await fixture.handler(
    new Request("https://example.com/thumbnail", {
      method: "POST",
      body: "not-json"
    })
  );
  assert.equal(response.status, 400);
  assert.equal(fixture.calls.length, 0);
  assert.match(await response.text(), /JSON/);
});

for (const failure of ["connect", "newPage", "close"] as const) {
  test(`browser ${failure} errors never expose endpoint credentials`, async () => {
    const fixture = await loadThumbnail(endpoint, failure);
    const response = await fixture.handler(request());
    assert.equal(response.status, failure === "close" ? 200 : 400);
    const visible = [await response.text(), ...fixture.logs]
      .map((value) => String(value))
      .join("\n");
    assert.ok(!visible.includes(endpoint));
    assert.ok(!visible.includes("synthetic-thumbnail-test"));
  });
}
