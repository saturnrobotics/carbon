// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// GET /api/v1/openapi.json — the generated OpenAPI 3 spec for the Carbon API.
// Public, so clients can generate a typed client in any language. Memoized at module
// scope (the router and its schemas are static for the process lifetime).
//
// Generated from `disclosedRouter`, not `router`: the document describes what an
// API key can call, and the workforce-only portal operations answer 404 to one.

import { CarbonJsonSchemaConverter } from "@carbon/api/schema";
import { OpenAPIGenerator } from "@orpc/openapi";
<<<<<<< HEAD
import { disclosedRouter } from "./lib/router.server";
import { specOptions } from "./lib/spec-options.server";
||||||| 85d9006e1
import { router } from "./lib/router.server";
import { specOptions } from "./lib/spec-options.server";
=======
import { router } from "./lib/router.server";
import { specOptions, withErrorResponses } from "./lib/spec-options.server";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75

// The promise, not the string: concurrent cold-start requests on this public
// route must share ONE generation of the 1,495-operation spec.
let cachedSpec: Promise<string> | null = null;

async function generateSpec(): Promise<string> {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new CarbonJsonSchemaConverter()]
  });
<<<<<<< HEAD
  const spec = await generator.generate(disclosedRouter, specOptions());
  return JSON.stringify(spec);
||||||| 85d9006e1
  const spec = await generator.generate(router, specOptions());
  return JSON.stringify(spec);
=======
  const spec = await generator.generate(router, specOptions());
  return JSON.stringify(withErrorResponses(spec as never));
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
}

export async function loader() {
  cachedSpec ??= generateSpec();
  return new Response(await cachedSpec, {
    headers: { "content-type": "application/json" }
  });
}
