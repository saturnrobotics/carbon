# Invoice verification and private operations

## Repeatable checks

The fork workflow `.github/workflows/saturn-invoice-check.yml` runs on pushes and
pull requests to `saturn/main`. It installs locked dependencies, runs invoice unit
and operator tests, provisions a fresh GitHub-hosted `crbn` stack, applies migrations,
runs transactional ERP/jobs tests, boots an isolated synthetic browser flow, and
checks scoped types. No private credentials,
bank/mailbox connection, or paid model is used. `crbn --run` removes its own fresh
volumes on exit. Do not copy the CI provisioning command into an existing local
development stack.

From the repository root, run credential-free unit checks:

```sh
python3 contrib/deploying/gcp-tailscale/check_invoice.py
pnpm --dir apps/erp test
```

The second command discovers the normal ERP suite, including unrelated upstream
tests; database and paid live suites require explicit invocation. Report failures
rather than omitting failing tests from discovery.

Database checks use an **already migrated, isolated localhost test database**:

```sh
export INVOICE_INTAKE_TEST_DATABASE_URL='postgresql://localhost:55432/invoice_test'
export MERCURY_TEST_DATABASE_URL="$INVOICE_INTAKE_TEST_DATABASE_URL"
export PAYMENT_SYNC_TEST_DATABASE_URL="$INVOICE_INTAKE_TEST_DATABASE_URL"
python3 contrib/deploying/gcp-tailscale/check_invoice.py --integration
```

For browser acceptance, export the same explicit local test database URLs plus
the local stack's `SUPABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, and normal development app environment.
Set `ERP_URL` to an **unused localhost port**. The maintained runner starts and
stops only its own ERP process, with a unique development login. It reuses the
local backend without resetting it and creates a new synthetic company.

```sh
pnpm --dir apps/erp exec playwright-core install chromium
python3 contrib/deploying/gcp-tailscale/check_invoice_browser.py --start-app \
  --directory contrib/deploying/gcp-tailscale/.local/invoice-browser-example
```

Use a new artifact directory for each run. `INVOICE_BROWSER_EXECUTABLE` may name
an existing local Chromium executable. The fixture generates PDFs, drives the real
worker with a fully substituted provider, and exercises native forms through
synthetic Draft approval. Assertions cover explicit master creation, idempotency,
zero ledger changes, retained corrections after reparse, stale evidence reasons,
complete Draft merge coverage, and archived original preview. Logs, state and
screenshots remain private. This proves application behavior, not live model
accuracy on real receipts.

Supply actual local authentication through private environment management. Never
use a production tunnel or a database containing valuable development records.
The runner does not load local `.env` files or create/reset a database. Missing or
non-local test URLs fail before tests run. `--environment` is restricted to GitHub
CI's generated `crbn` environment and handles quoted values without shell execution.
Provider/mailbox credentials are cleared for these commands.

## Maintained VM operator

`run_invoice_operator.py` loads the source-controlled ERP
`invoice-operator.server.ts` from the exact deployed Ops image using its existing
Vite/Babel/Lingui transforms. It does not copy private TypeScript or invoke Vitest.
It checks the manifest against `/var/lib/carbon/runtime/revision`, verifies the
running ERP image, and pins Ops to its immutable image ID with `--pull never`.

Create a mode-0700 directory under `/var/lib/carbon/invoice-operations/` containing
a mode-0600 `operator.json`. Replace this synthetic template with private values:

```json
{
  "companyId": "example-company-id",
  "userId": "example-operator-id",
  "requiredRevision": "0000000000000000000000000000000000000000",
  "identity": {
    "modelId": "configured-deployed-model-id",
    "promptVersion": "deployed-INVOICE_PROMPT_VERSION",
    "schemaVersion": "deployed-INVOICE_SCHEMA_VERSION"
  },
  "maxNewExtractions": 0,
  "steps": [{
    "action": "reuse",
    "intakeId": "example-intake-id",
    "expectedRevision": 1,
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }]
}
```

Copy prompt/schema constants from the deployed source and the model from its private
configuration. Reuse requires the exact completed extraction's model, prompt,
schema, registered source path and valid result schema. Apply also verifies source
bytes against SHA-256. A past generation is not accepted as a current review.

| Action | Required step fields | Effect during apply |
| --- | --- | --- |
| `refresh` | `importId` | Refresh this non-ignored Mercury payment and canonically register its sources. Temporarily defer Gmail, then restore its controls. |
| `normalize` | `intakeId`, `expectedRevision` | Return a missing-file intake to NeedsDocument through the canonical status action. |
| `reuse` | `intakeId`, `expectedRevision`, `sha256` | Verify existing extraction and source identity; no paid fallback. |
| `parse` | `intakeId`, `expectedRevision`, `sha256` | Parse only untouched intake with one eligible document. Existing attempts/reviewed facts require manual handling. |

Use separate manifests for collection and later parsing: collection can change
ownership/revisions. `maxNewExtractions` defaults to zero and allows at most ten
planned parse steps. Existing company daily/monthly budgets still govern worker
admission; the step count is not a currency spending cap. No operator action
approves a purchase, creates masters, posts ledgers, or settles payments.

On the VM, invoke the launcher from the exact deployed release:

```sh
sudo python3 /var/lib/carbon/releases/DEPLOYED_REVISION/contrib/deploying/gcp-tailscale/run_invoice_operator.py \
  --directory /var/lib/carbon/invoice-operations/example-run
sudo python3 /var/lib/carbon/releases/DEPLOYED_REVISION/contrib/deploying/gcp-tailscale/run_invoice_operator.py \
  --directory /var/lib/carbon/invoice-operations/example-run --mode check --execute
```

The first command only prepares launch configuration. The second reads the database
and writes `check.json`; it makes no bank/model request. Review its source identities,
revisions and reusable attempts before applying. It also fingerprints native
financial/master rows and Mercury approval links. This structural check does not
claim that every extracted fact matches the printed invoice.

After reviewing and authorizing the manifest:

```sh
sudo python3 /var/lib/carbon/releases/DEPLOYED_REVISION/contrib/deploying/gcp-tailscale/run_invoice_operator.py \
  --directory /var/lib/carbon/invoice-operations/example-run --mode apply --execute
```

Apply serializes operator runs, records and pauses the scheduler, saves original
company settings **before** changing them, records completed steps, and verifies
the financial/link baseline. Progress and original settings survive in
`checkpoint.json`. Completed steps are not repeated. A parse admission is persisted
before queuing and is spent even after interruption; rerunning cannot authorize a
second call. Failed or interrupted work is removed from the scheduler's queue and
requires inspection before any newly authorized attempt.

## Recovery

Keep the original manifest/checkpoints. After an interruption:

```sh
sudo python3 /var/lib/carbon/releases/DEPLOYED_REVISION/contrib/deploying/gcp-tailscale/run_invoice_operator.py \
  --directory /var/lib/carbon/invoice-operations/example-run --mode recover --execute
```

Recovery restores inference, automatic-intake and Mercury/mailbox settings without
collection/inference, then restarts Inngest only if it was originally running. A
failed settings restore leaves the scheduler paused until recovery succeeds.
Recovery may use a newer deployed runtime, still pinned to its running immutable
image; it keeps the original manifest unchanged and validates its checkpoint hash.
Check/apply continue to require the manifest's exact deployed revision.
`scheduler.json` also survives a killed wrapper. Resume apply only after successful
recovery; changed revisions or financial links require a new reviewed manifest.

Keep configuration, reports, checkpoint, scheduler marker, generated Compose file
and logs mode 0600. They contain private operational evidence and must never enter
Git or public release logs.
