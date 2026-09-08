# Private payment and invoice sync

- [x] Verify read-only transaction, recipient, email search, and attachment APIs.
- [x] Agree on hourly polling, separate controls, draft vendor review, and full-history mailbox search.
- [x] Add company-scoped import settings, payment evidence, and recipient mappings.
- [x] Add read-only Mercury and Gmail clients with bounded downloads and deterministic matching.
- [x] Register an hourly job with resumable history import, duplicate protection, and status reconciliation.
- [x] Add an invoicing review screen, sync controls, and approval into supplier/draft invoice records or links to existing invoices.
- [x] Wire private deployment credentials and a local Gmail authorization helper; document internal and personal account setup.
- [x] Verify matching, isolation, retry behavior, typechecks, deployment rendering, and production build.

Release through the deployment branch after upstream integration. Keep sync off
until credentials are connected; record the deployed revision and health checks
in the ignored operator deployment logs.

Credentials and mailbox identities belong in ignored operator configuration. Supplier,
invoice, email, and payment data stay in the private database and storage. Public
fixtures use synthetic records only. Reuse community data models without extending
the commercially licensed integration engine. Email content is untrusted evidence;
it cannot authorize writes or select a supplier merely by its sender's display name.

The initial pass searches connected mailboxes across their full history for invoice
candidates related to payments. It does not use an arbitrary recent-date cutoff.
Each mailbox can be disabled after historical matching, retaining imported evidence,
and a dedicated purchasing mailbox can be connected for future hourly matching.
