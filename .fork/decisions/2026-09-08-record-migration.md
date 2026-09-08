# Separate fork records from upstream agent history

Context: upstream integrations repeatedly touched shared agent records even when
application code had no conflict.

Decision: fork-owned plans, specs, research, playbooks, lessons, and decisions live
under `.fork/`. New runtime logs and process state live in ignored `.fork/local/`.
The root policy maps inherited skill destinations without forking every upstream
skill. `CLAUDE.md` already imports `AGENTS.md`, and the existing skill installer
already discovers new skill directories; neither needs a second implementation.

Migration provenance:

- Source revision: `6b5f5c5944caf933c7c8236bba10e4f7377be626`.
- Upstream revision: `96767291a7459fe51a781357d816da957a009c80`, also the source's merge base with upstream.
- All 22 fork-only authored `.ai/` records moved as listed below. Their content was
  compared byte-for-byte after substituting only the moved cross-record paths.
- `.ai/lessons.md` differed only by three inserted blocks. All 22 inserted
  lesson sections were preserved individually under `.fork/lessons/`; only blank
  separator lines were normalized. The restored upstream file was compared
  byte-for-byte with the upstream revision. Duplicate lessons introduced during
  the prior integration remain preserved; no historical advice was silently lost.
- Prior authored run reports and one synthetic benchmark report are archived in
  `.fork/decisions/archive/` to preserve evidence. They are historical observations,
  not current release verification or a destination for new runtime output.
- No external inbound references to the moved paths existed. Cross-record
  references were rewritten to their corresponding new paths.

| Previous path | Preserved path |
| --- | --- |
| `.ai/plans/2026-09-06-cold-backups.md` | `.fork/plans/2026-09-06-cold-backups.md` |
| `.ai/plans/2026-09-06-fork-deployment-branch.md` | `.fork/plans/2026-09-06-fork-deployment-branch.md` |
| `.ai/plans/2026-09-06-invoice-intake.md` | `.fork/plans/2026-09-06-invoice-intake.md` |
| `.ai/plans/2026-09-06-payment-invoice-sync.md` | `.fork/plans/2026-09-06-payment-invoice-sync.md` |
| `.ai/plans/2026-09-06-private-gcp-self-host.md` | `.fork/plans/2026-09-06-private-gcp-self-host.md` |
| `.ai/plans/2026-09-06-shared-private-postgres.md` | `.fork/plans/2026-09-06-shared-private-postgres.md` |
| `.ai/plans/2026-09-07-company-knowledge-platform.md` | `.fork/plans/2026-09-07-company-knowledge-platform.md` |
| `.ai/plans/2026-09-07-invoice-review-preservation.md` | `.fork/plans/2026-09-07-invoice-review-preservation.md` |
| `.ai/plans/2026-09-07-mercury-receipt-corrections.md` | `.fork/plans/2026-09-07-mercury-receipt-corrections.md` |
| `.ai/plans/2026-09-08-automatic-release-preparation.md` | `.fork/plans/2026-09-08-automatic-release-preparation.md` |
| `.ai/playbooks/invoice-document-intake.md` | `.fork/playbooks/invoice-document-intake.md` |
| `.ai/research/invoice-intake.md` | `.fork/research/invoice-intake.md` |
| `.ai/runs/2026-09-07-company-knowledge-platform.md` | `.fork/decisions/archive/2026-09-07-company-knowledge-platform.md` |
| `.ai/runs/2026-09-07-invoice-review-preservation.md` | `.fork/decisions/archive/2026-09-07-invoice-review-preservation.md` |
| `.ai/runs/2026-09-07-mercury-receipt-corrections.md` | `.fork/decisions/archive/2026-09-07-mercury-receipt-corrections.md` |
| `.ai/runs/2026-09-07-mercury-review-ui.md` | `.fork/decisions/archive/2026-09-07-mercury-review-ui.md` |
| `.ai/runs/2026-09-08-automatic-release-preparation.md` | `.fork/decisions/archive/2026-09-08-automatic-release-preparation.md` |
| `.ai/runs/2026-09-08-dataset-check-configuration.md` | `.fork/decisions/archive/2026-09-08-dataset-check-configuration.md` |
| `.ai/runs/2026-09-08-deploy-missing-input.md` | `.fork/decisions/archive/2026-09-08-deploy-missing-input.md` |
| `.ai/runs/2026-09-08-local-manual-verification.md` | `.fork/decisions/archive/2026-09-08-local-manual-verification.md` |
| `.ai/runs/knowledge-performance-100k.json` | `.fork/decisions/archive/knowledge-performance-100k.json` |
| `.ai/specs/implemented/2026-09-06-invoice-intake.md` | `.fork/specs/implemented/2026-09-06-invoice-intake.md` |

Verification: the installer fixture proves root policy discovery for both harness
entry points, registration of the fork-maintenance skill, and replacement of a
stale generated harness copy without changing authored policy. Policy cold-reading
and the integration gate validate future instruction and enforcement changes.
