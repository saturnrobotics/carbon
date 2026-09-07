# Private invoice and receipt intake

Invoice intake keeps source files in the existing private Supabase bucket and review data in Postgres. Employees review supplier/item identities and purchasing units before Carbon creates a **Draft** purchase invoice. This does not receive inventory, post accounting, or mark an invoice paid.

Managed inference is optional and defaults off. The ERP and manual document review remain available without Google inference configuration. Mercury history backfill is a separate explicit action; deployment never starts it.

## One-time operator setup

1. Use the existing laptop deployment configuration. Create the following additional file locally:

   ```sh
   umask 077
   mkdir -p contrib/deploying/gcp-tailscale/.local
   ```

2. Save this JSON as `contrib/deploying/gcp-tailscale/.local/invoice-inference.json`, replacing the example project with your existing deployment project. Keep every value a JSON **string**. Verify current **non-global, standard** model prices before enabling; the values below were checked on 2026-09-06.

   ```json
   {
     "INVOICE_INTAKE_ENABLED": "true",
     "INVOICE_AI_PROJECT": "example-project",
     "INVOICE_AI_LOCATION": "us",
     "INVOICE_AI_MODEL": "gemini-3.5-flash",
     "INVOICE_AI_INPUT_PRICE_USD_PER_MILLION": "1.65",
     "INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION": "9.90",
     "INVOICE_AI_PRICE_VERIFIED_AT": "2026-09-06",
     "INVOICE_AI_MAX_INPUT_TOKENS": "32768",
     "INVOICE_AI_MAX_OUTPUT_TOKENS": "16384"
   }
   ```

3. Restrict its permissions:

   ```sh
   chmod 600 contrib/deploying/gcp-tailscale/.local/invoice-inference.json
   ```

   Never commit this file or a Google service account key. The deploy script rejects tracked inputs and requires private file permissions. If you pass an alternative private `config.json`, place `invoice-inference.json` beside that file.

4. Run the existing deployment command from `saturn/main` after merging the feature and current upstream changes:

   ```sh
   make deploy
   ```

   On first enablement this enables the Google AI Platform and IAM APIs, creates a dedicated service account and custom project role containing only `aiplatform.endpoints.predict`, and attaches that account to the existing VM with the `cloud-platform` OAuth scope. Attaching the account briefly stops and restarts the VM. Your laptop operator therefore needs permission to enable APIs, manage the custom role/service account and its project binding, act as the new account, and stop/update/start the VM. A newly created identity may take a short time to propagate through Google IAM; deployment retries that specific error for a bounded interval before stopping. Repeated deployments retain the same identity. Unexpected existing VM identities or broader project grants stop deployment for review.

5. In ERP, open **Invoicing → Document Inbox** and its settings. Enable inference for the company and set the daily and monthly USD inference budgets. Upload a small **synthetic** receipt first. A successful ERP health check does not prove that the selected Google model or permissions work; verify that this document reaches review and shows its extraction result. Verify classification quality before starting historical backfill.

Google authentication uses short-lived tokens from the VM metadata server. There is no API key, secret JSON file, model gateway, or additional production dependency. All programs with access to that VM's metadata identity can request the same limited inference permission; this is a VM boundary, not container-level identity isolation.

## Processing region and cost limits

The provider uses the explicit US multi-region endpoint:

```text
https://aiplatform.us.rep.googleapis.com/v1/projects/PROJECT/locations/us/publishers/google/models/MODEL:generateContent
```

`us` is the inference processing location, separate from the VM's deployment region. There is no global fallback. Private input bytes go directly to this authenticated API over outbound HTTPS, never through a public file URL. Existing NAT access is used; no public inbound route or DNS change is added. Tools, URL grounding, prompt caching, and request/response logging are not enabled by this integration. Google's service retention terms still apply; this configuration does not claim unconditional zero retention.

Before each paid call, the worker obtains a free token-count estimate and reserves **twice** the counted input, one additional token per UTF-8 byte of the serialized response schema, and the configured maximum output (including reasoning). This explicit schema allowance supplements the margin for multimodal estimates. It checks the company's UTC daily/monthly budgets in Postgres; if the reserved input exceeds the configured token bound, processing returns to review. Google documents multimodal counts as estimates; these application limits are conservative admission controls, not a guaranteed hard cap on Google's eventual bill. Actual usage replaces the estimate when available. Ambiguous timeouts keep the reservation. Failed schema validation still records reported token charges.

Two paid calls can be active across workers. Extraction and explicit model match suggestions share three persisted paid attempts per intake generation. Retries never disappear from the budget when a document is edited or a generation changes. Five-minute reconciliation resumes lost events and expired work. Matching failures preserve the extracted invoice.

Default input limits are 10 MiB/20 pages for PDFs and 7,000,000 bytes for PNG/JPEG images; extraction accepts at most 500 lines. Oversized or unsupported documents require manual review or a smaller complete source document. An unsupported/unavailable model or unknown price configuration produces an error; the system does not silently switch models.

## Pause, change models, and recover

- **Pause now:** turn off inference in the company's inbox settings. This stops new provider calls without removing documents or disabling manual review. An already submitted provider request can still complete and incur its charge.
- **Pause automatic Mercury intake:** use its separate settings toggle. Stored history and manual uploads remain available.
- **Change a model:** pause company inference, edit the ignored JSON model and both verified price values/date, run `make deploy`, and run the synthetic evaluation before re-enabling. To roll back a model, restore its previous model/rate configuration and deploy again. Each attempt retains its original model/rate snapshot.
- **Budget exhausted:** increase the appropriate company budget or wait for the next UTC budget window. The durable queue remains visible.
- **Identity/model error:** verify the project API, dedicated account binding, configured model availability in `us`, and current pricing. Private local/VM logs contain deployment diagnostics; do not paste secrets, receipts, supplier names, or email content into the public repository.
- **Interrupted worker:** reconciliation replays already committed extraction evidence without another paid request. A stale completion updates its original billing record but cannot overwrite a newer review.

Daily system backups already include Postgres and private object storage. Invoice intake adds no separate storage service to back up.

## Google references

- [US processing endpoints and model availability](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations)
- [Structured response schemas](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output)
- [Inference IAM permission](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/access-control)
- [Metadata authentication for Compute workloads](https://docs.cloud.google.com/compute/docs/access/authenticate-workloads)
- [Model lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)
- [Current model pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)
- [Token estimates](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/get-token-count)
- [Service retention terms](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention)

## Synthetic evaluation before a historical run

Run these commands on the laptop to generate the public synthetic corpus into an ignored directory. The renderer uses locally installed Python Pillow and Arial/DejaVu Sans; these are development tools, not application dependencies.

```sh
export INVOICE_EVAL_OUTPUT_DIR="$PWD/contrib/deploying/gcp-tailscale/.local/invoice-evaluation/corpus"
corepack pnpm --filter @carbon/jobs exec tsx src/scripts/evaluate-invoice-intake.ts --generate
```

The generated `fixtures.json` contains labels for thirty receipts/invoices and the neighboring files contain native PDFs, raster scans and photographed receipt simulations. Some PDFs have several pages. The set includes discounts, freight, tax-inclusive/exclusive pricing, changed quantities/prices, an absent invoice reference, packs, a changed revision, exceptions and an exact-byte duplicate. Keep the labels and generated files together. `synthetic-21` through `synthetic-25` are held-out repeat purchases; establish the supplier/SKU/unit mappings using earlier samples, then measure these without correcting or teaching their identities first.

The executable live runner creates one isolated synthetic company per candidate using Carbon's normal `seed-company` initialization. It assigns the existing operator an employee location and creates the four fixture units. The company names begin with `Invoice Inference Evaluation`; no real-company invoice settings are changed. It records each initial machine result before applying explicit synthetic corrections through the normal save and approval transactions. Fifteen ordinary documents among the first twenty create Draft invoices, all three suppliers and all five item classes, teaching the saved identity rules. Complex charge/FX examples remain review probes. The five held-out receipts are measured without correcting their identities. No inventory receipt, accounting posting or payment is created.

1. Deploy the selected revision with the global ignored inference configuration enabled, so the VM identity and Google API are configured. Keep inference disabled in **all real companies** while testing. The live runner temporarily enables only its synthetic companies and restores their prior settings afterward.

2. Create `live.json` beside the generated `fixtures.json`, with mode `0600`. Use the existing operator's Carbon **user ID**, not an email or Google credential. The operator must be an active employee with settings creation permission. The runner uses normal company initialization to grant access to each new synthetic company. Do not add `companyId` entries manually. The runner writes its generated run ID and company IDs back to this private file so an interrupted run can resume.

   ```json
   {
     "userId": "replace-with-the-existing-carbon-user-id",
     "project": "example-project",
     "priceVerifiedAt": "2026-09-06",
     "maxCostUsd": 5,
     "models": [
       {"id": "gemini-3.5-flash", "inputPrice": 1.65, "outputPrice": 9.90},
       {"id": "gemini-3.5-flash-lite", "inputPrice": 0.33, "outputPrice": 2.75}
     ]
   }
   ```

   `maxCostUsd` is divided equally across candidate companies as their UTC daily/monthly admission budgets; existing lower company limits are preserved. It is subject to the same conservative-estimate limitation described above. Verify model prices before use. Use a fresh private directory/run ID for a new quality experiment; keep checkpoints intact when resuming an interrupted experiment.

3. Copy this private directory to the VM under `/var/lib/carbon/invoice-evaluation/`, for example `/var/lib/carbon/invoice-evaluation/first-run`. Use the deployment's existing IAP SSH/SCP access. Keep the directory mode `0700` and `live.json` mode `0600`. Generated PDFs/images, labels, `samples.json`, `report.json`, logs and generated Compose configuration must remain private. No credential file needs to be copied; the Ops container uses the existing deployment secrets and attached VM identity.

4. On the VM, replace `DEPLOYED_REVISION` below with the value in `/var/lib/carbon/runtime/revision`. First prepare without sending any model requests:

   ```sh
   sudo python3 /var/lib/carbon/releases/DEPLOYED_REVISION/contrib/deploying/gcp-tailscale/run_invoice_evaluation.py --directory /var/lib/carbon/invoice-evaluation/first-run
   ```

   Then run the explicit paid comparison:

   ```sh
   sudo python3 /var/lib/carbon/releases/DEPLOYED_REVISION/contrib/deploying/gcp-tailscale/run_invoice_evaluation.py --directory /var/lib/carbon/invoice-evaluation/first-run --apply
   ```

   The runner uses the **Ops image of the deployed revision**, imports the real ERP validation/approval code with its production transforms, and calls the normal persisted worker. It temporarily stops Inngest dispatch so the regular configured model cannot claim comparison documents, then restarts it in `finally` if it was previously running. The application remains available; scheduled work resumes afterward. Do not run multiple evaluations concurrently. A company budget or provider error leaves reviewable evidence and private diagnostics; it never bypasses the attempt/budget checks.

5. Read the private `report.json`. Each candidate has its own pass/fail, extraction accuracy, omissions, repeat selection correctness, observed/unexpected Ready counts, latency and actual charges. Exact duplicates count their shared paid attempt once. A comparison succeeds if **at least one complete candidate passes**; choose a passing model, then deploy that model and its verified prices in the ignored inference configuration. A failed/incomplete candidate remains visible in the report. Keep real-company inference/history disabled until a candidate passes and browser/permission checks are complete.

The release gate requires all thirty source observations, known charges, valid schemas, correct document kinds, flagged missing lines, at least 95% financial accuracy, no unexpected Ready documents and correct supplier/item/unit/conversion selections and a persisted Ready status for all five held-out receipts. Supplier names, invoice references and printed item identities are also checked when assessing an unexpected Ready result. Optional correction-effort counters are reported as unknown when unmeasured; they are not fabricated from confidence. Model confidence is never a correctness metric.

The private checkpoint contains the original machine output before teaching. Resuming never replaces it with the corrected review or pays for a completed extraction again. Synthetic Draft invoices and evidence remain in their test companies for inspection; deleting those companies is a separate explicit operator action.

For offline re-scoring of an existing private `samples.json`:

```sh
export INVOICE_EVAL_INPUT_DIR="$PWD/contrib/deploying/gcp-tailscale/.local/invoice-evaluation/results"
export INVOICE_EVAL_OUTPUT_DIR="$PWD/contrib/deploying/gcp-tailscale/.local/invoice-evaluation/report"
corepack pnpm --filter @carbon/jobs exec tsx src/scripts/evaluate-invoice-intake.ts
```

The offline scorer never sends a document or prompt to a provider. A passing unit test against synthetic model responses proves the scorer's behavior; only the live comparison measures actual model quality. This gate supplements permission, inventory/accounting, duplicate, transaction and browser checks.
