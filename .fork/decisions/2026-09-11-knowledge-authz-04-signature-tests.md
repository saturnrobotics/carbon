# Knowledge authorization Task 04: real-signature verifier proof and caller registry validation

Implements Task 04 of `.fork/plans/2026-09-11-knowledge-authorization.md` on
`saturn/main` at `7464d10347`. Local proof only; nothing here touches Google or
a cloud environment.

`GoogleWorkforceTokenVerifier` now takes an options object: `oauthClient`,
`serviceCertificatesUrl`, `iapPublicKeysUrl` and `nowEpochSeconds`. The URL
options default to Google's endpoints through the client's own `endpoints`
setting, so production call sites (`new GoogleWorkforceTokenVerifier()`) are
unchanged. The clock option exists because the IAP key cache has a five-minute
lifetime and a sixty-second refresh floor, and a test must move that clock
without moving the JWT clock the library reads. Only the existing stub-based unit
test changed its constructor call; its assertions are intact.

`identity.signature.test.ts` generates RSA keys in-process, serves PEM key
documents from a loopback HTTP server, and drives the real verifier through
`verifyWorkforceRequest`. Proven: a valid pair passes end to end; a tampered
payload, a key absent from the served document, a rogue key claiming a served
`kid`, a foreign service issuer, a foreign IAP issuer and an audience mismatch all
fail for the library's stated reason. IAP rotation is honoured only after the
forced refresh runs past the refresh floor, and the retired key is refused from
then on; service-certificate rotation is visible on the next fetch. The rotation
behaviour before the refresh floor is asserted too, since that window is the
existing design.

The trusted-caller registry now has three layers with distinct jobs. The runtime
zod schema is unchanged: the local Docker fixtures use plain labels for audiences
and subjects, so tightening it would break the local workflow. Release rules
therefore live in `src/trusted-callers.ts`, reached through
`pnpm --filter @carbon/knowledge callers:validate <file>`: the receiver audience
must be a bare https URL (the same `isServiceAudience` rule outbound token
minting applies), service-account subjects must be numeric unique IDs and unique
across callers, and IAP audiences must be `/projects/...` paths. The validator
also checks `callers.schema.json` with a purpose-built validator for the schema's
own keyword subset that throws on any keyword it does not implement, so a schema
edit cannot silently escape the check. A test pins the zod schema and the JSON
Schema to identical verdicts on twenty-one fixtures; the single divergence is
subject uniqueness, which JSON Schema cannot express, and the test asserts that
it is the only one. `callers.schema.json` gained `$defs.boundedString` with a
non-whitespace pattern so whitespace-only strings are refused by both schemas.

`contrib/deploying/knowledge/callers.example.json` is a synthetic two-caller
registry validated by the `fork-checks` node job on every change to
`contrib/deploying/**`, the validator or `identity.server.ts`.

Verification on the branch: `pnpm --filter @carbon/knowledge test` (27 files,
152 tests), `pnpm exec turbo run typecheck --filter=@carbon/knowledge`, strict
Biome on every changed file under `src/` and the deployment JSON, actionlint on
`fork-checks.yml`, the example registry accepted (exit 0) and a registry with a
duplicate subject or an http audience rejected (exit 1). Biome does not process
`packages/*/scripts/**`, so the CLI's content was linted through a temporary copy
under `src/`; see the lesson of the same date.
