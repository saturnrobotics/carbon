<<<<<<< HEAD
import fs from "node:fs";
import {
  createScriptClient,
  readLocalScriptConfig
} from "./lib/local-script-config";
||||||| 85d9006e1
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const companyId = "********************";
const apiKey = "crbn_******************";
const publicApiKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxb2ppamlpamtuaGJneW9nbWx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjM2MDU0MzksImV4cCI6MjAzOTE4MTQzOX0.JMzLs9Y4Y4kQ-jhQHrSqgNyHSZgrkwzBd1PwPbVPtbQ";
=======
// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75

<<<<<<< HEAD
||||||| 85d9006e1
const carbon = createClient("https://api.carbon.ms", publicApiKey, {
  global: {
    headers: {
      "carbon-key": apiKey,
    },
  },
});
=======
import fs from "node:fs";
import {
  createScriptClient,
  readLocalScriptConfig
} from "./lib/local-script-config";

>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
const {
  CARBON_COMPANY_ID: companyId,
  CARBON_API_KEY: apiKey,
  SUPABASE_URL: carbonApiUrl,
  SUPABASE_ANON_KEY: publicApiKey,
  SALES_INVOICE_REPORT_PATH: outputPath
} = readLocalScriptConfig(
  [
    "CARBON_COMPANY_ID",
    "CARBON_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SALES_INVOICE_REPORT_PATH"
  ],
  process.env
);

const carbon = createScriptClient(carbonApiUrl, publicApiKey, apiKey);

(async () => {
  const { data, error } = await carbon
    .from("salesInvoice")
    .select(
      "*, salesInvoiceLine(*), salesInvoiceShipment(*), customer!salesInvoice_customerId_fkey(name, tags)"
    )
    .eq("companyId", companyId)
    .limit(1000)
    .order("createdAt", { ascending: false });

  if (data) {
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  }

  if (error) {
    process.stderr.write("Sales invoice query failed.\n");
    process.exitCode = 1;
  }
})().catch(() => {
  process.stderr.write("Sales invoice report failed.\n");
  process.exitCode = 1;
});
