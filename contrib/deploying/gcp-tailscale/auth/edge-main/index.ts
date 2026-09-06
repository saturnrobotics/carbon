// Production replacement for the development edge-runtime dispatcher.
import { createDispatcher } from "./handler.ts";

const handler = createDispatcher({
  jwtSecret: Deno.env.get("JWT_SECRET") ?? "",
  allowedOrigins: [Deno.env.get("ERP_URL"), Deno.env.get("MES_URL")]
    .filter((value): value is string => Boolean(value))
    .map((value) => new URL(value).origin),
  dispatch: async (functionName, request) => {
    // @ts-ignore EdgeRuntime is provided by supabase/edge-runtime.
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: `/home/deno/functions/${functionName}`,
      memoryLimitMb: 512,
      workerTimeoutMs: 5 * 60 * 1000,
      noModuleCache: false,
      importMapPath: "/home/deno/functions/deno.json",
      envVars: Object.entries(Deno.env.toObject())
    });
    return worker.fetch(request);
  }
});

Deno.serve(handler);
