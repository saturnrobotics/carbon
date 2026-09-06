import { verifySupabaseJwt } from "./jwt.ts";

type DispatcherOptions = {
  jwtSecret: string;
  allowedOrigins: string[];
  dispatch: (functionName: string, request: Request) => Promise<Response>;
  nowSeconds?: () => number;
};

// These two upstream verify_jwt=false functions only transform uploaded image
// bytes. Real browser upload call sites do not send a bearer. All other functions
// require a verified JWT. This is an explicit list, never a general opt-out.
const imageFunctions = new Set(["image-resizer", "logo-resizer"]);

export function createDispatcher(options: DispatcherOptions) {
  if (!options.jwtSecret) throw new Error("JWT_SECRET is required");
  const allowedOrigins = new Set(options.allowedOrigins);

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    const corsHeaders = new Headers({ Vary: "Origin" });
    if (origin && allowedOrigins.has(origin)) {
      corsHeaders.set("Access-Control-Allow-Origin", origin);
      corsHeaders.set(
        "Access-Control-Allow-Headers",
        "authorization, x-client-info, apikey, content-type, carbon-key, x-company-id, x-user-id"
      );
      corsHeaders.set(
        "Access-Control-Allow-Methods",
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
      );
    }

    const failure = (status: number, message: string) => {
      const headers = new Headers(corsHeaders);
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "no-store");
      return new Response(JSON.stringify({ message }), { status, headers });
    };

    if (origin && !allowedOrigins.has(origin)) {
      return failure(403, "Origin is not allowed");
    }

    // Kong strips /functions/v1/ before forwarding to the dispatcher.
    const functionName = new URL(request.url).pathname.split("/")[1];
    if (!functionName || !/^[a-z][a-z0-9-]*$/.test(functionName)) {
      return failure(404, "Function not found");
    }

    // Preflight never creates or executes a user worker.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const imageUpload =
      imageFunctions.has(functionName) && request.method === "POST";
    if (!imageUpload) {
      const claims = await verifySupabaseJwt(
        request.headers.get("Authorization"),
        options.jwtSecret,
        options.nowSeconds?.() ?? Math.floor(Date.now() / 1000)
      );
      if (!claims)
        return failure(401, "A valid authorization token is required");

      // util.wake_event_queue sends the signed anon key through pg_net. It only
      // wakes a queue processor; the request cannot supply a job or business data.
      if (claims.role === "anon" && functionName !== "event-wake") {
        return failure(403, "Authentication is required");
      }
    }

    try {
      const result = await options.dispatch(functionName, request);
      const headers = new Headers(result.headers);
      headers.delete("Access-Control-Allow-Origin");
      for (const [key, value] of corsHeaders) headers.set(key, value);
      return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers
      });
    } catch {
      // Do not return worker paths, secrets, SQL errors or stack traces.
      return failure(500, "Function execution failed");
    }
  };
}
