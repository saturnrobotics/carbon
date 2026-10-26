<<<<<<< HEAD
import {
  createScriptClient,
  readLocalScriptConfig
} from "./lib/local-script-config";
||||||| 85d9006e1
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
=======
// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75

<<<<<<< HEAD
const { SUPABASE_URL, SUPABASE_ANON_KEY, CARBON_API_KEY } =
  readLocalScriptConfig(
    ["SUPABASE_URL", "SUPABASE_ANON_KEY", "CARBON_API_KEY"],
    process.env
  );
||||||| 85d9006e1
config();
=======
import {
  createScriptClient,
  readLocalScriptConfig
} from "./lib/local-script-config";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75

<<<<<<< HEAD
||||||| 85d9006e1
const carbon = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
  {
    global: {
      headers: {
        "carbon-key": "crbn_yPkz1hszqh6mVLDf4jiDv",
      },
    },
  }
=======
const { SUPABASE_URL, SUPABASE_ANON_KEY, CARBON_API_KEY } =
  readLocalScriptConfig(
    ["SUPABASE_URL", "SUPABASE_ANON_KEY", "CARBON_API_KEY"],
    process.env
  );

>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
const carbon = createScriptClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  CARBON_API_KEY
);

(async () => {
  const employees = await carbon.from("salesOrder").select("*").limit(1000);

  process.stdout.write(`${JSON.stringify(employees, null, 2)}\n`);
})();
