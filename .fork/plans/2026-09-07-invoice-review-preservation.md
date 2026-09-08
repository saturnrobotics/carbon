# Invoice review preservation and release verification

Branch: `saturn/fix-invoice-review-preservation`, based on `saturn/main`.

Scope: apply the findings from the receipt-intake self-review. Keep Mercury-only acquisition, explicit approval, private originals, and native Draft-only effects. No real purchase approvals or database rebuilds.

- [x] Preserve saved human header/line decisions when receipts arrive or are reparsed; retain new extraction as independent evidence. Prove the previously failing late-file and retry cases.
- [x] Apply one Mercury source-eligibility policy to duplicate-payment association and archived/current attachment provenance. Validate image contents before paid admission using existing dependencies.
- [x] Require explicit, evidence-bound decisions for unresolved Mercury attachments; reject stale payment explanations.
- [x] Require coverage of retained financial lines when enriching an existing Draft so the resulting invoice cannot silently exceed the reviewed total. Preserve comment lines.
- [x] Default the inbox to actionable receipts and expose bank context for missing-document follow-up. Show preserved-review and unresolved-evidence decisions clearly.
- [x] Add repeatable local/CI invoice checks on the deployment branch, including explicit local-database integration and synthetic browser verification; maintain a generic private operator instead of an ignored one-off harness.
- [x] Correct stale acceptance claims and record red/green proof, scoped type/lint/test results, browser behavior, and independent review before the final release commit.
- [ ] Merge into `saturn/main`, include current upstream, deploy once from the laptop, verify immutable images and private service readiness, and retain private operational evidence without another notes-only rollout.

Release execution is recorded separately in the private deployment report for the resulting commit; this source checklist is finalized before rollout to avoid a notes-only deployment.

No schema migration is planned. Additive review and acquisition metadata uses existing JSON contracts with conservative defaults for older records. Production verification is read-only unless a concrete repair is shown to be necessary; no automatic real financial approval, receiving, posting, or settlement.
