# Mercury payments and Gmail invoice matching

The community connector imports outgoing Mercury payment evidence into
**Invoicing → Mercury payments**. It proposes vendors, finds related invoice
emails, and creates a supplier and draft purchase invoice after review. It uses
read-only Mercury and Gmail access. It never initiates a bank payment or sends,
deletes, or marks an email as read.

Hourly sync, Gmail matching, and each connected mailbox can be paused in the
application without redeploying. The first pass includes all Mercury history
unless a start date is explicitly set. Gmail searches all retained mailbox
history for invoices related to those payments, including archived mail, Spam,
and Trash, without a recent-date cutoff.
Historical imports advance in bounded batches and resume on subsequent runs.

## 1. Bind credentials to the right Carbon company

1. Sign in to the private ERP and open **Invoicing → Mercury payments**.
2. Copy the company ID shown in the setup information.
3. Open the ignored `contrib/deploying/gcp-tailscale/.local/config.json`.
4. Add `"PAYMENT_SYNC_COMPANY_ID": "the-copied-company-id"` to that JSON object.
   This binding prevents another company in the same ERP from using your bank
   or mailbox credentials.

Keep sync off until the following connections are ready.

## 2. Connect Mercury

1. Sign in to Mercury and select the correct organization.
2. Open **Settings → Tokens → Create an API Token**.
3. Select **Read Only** and give the token a recognizable name.
4. Copy the token into the ignored
   `contrib/deploying/gcp-tailscale/.local/secrets.json` as
   `"MERCURY_API_TOKEN": "the-token"`. Preserve the token's complete prefix.
5. Keep that file mode `600`. Do not paste the token into source files, shell
   commands, chat, screenshots, or a GitHub issue.

No Mercury MCP connection is required for this server-side sync.

## 3. Prepare Google OAuth for the mailboxes

Gmail access is separate from ERP Google login. Do not change the ERP login
callback or its Workspace-domain restriction.

For an organizational Google Workspace mailbox:

1. Open Google Cloud Console and select the ERP's organization-owned project.
2. Go to **APIs & Services → Library**, search for **Gmail API**, and enable it.
3. Open **Google Auth Platform → Audience**. Use **Internal** for the Workspace
   connection. Your existing internal application can remain internal.
4. Under **Data Access**, add only
   `https://www.googleapis.com/auth/gmail.readonly` for this connection.
5. Under **Clients**, create a **Desktop app** OAuth client named for the invoice
   importer. Download its JSON credentials.
6. Move that file to
   `contrib/deploying/gcp-tailscale/.local/gmail-workspace-client.json` and run:

   ```sh
   chmod 600 contrib/deploying/gcp-tailscale/.local/gmail-workspace-client.json
   ```

For a personal `@gmail.com` mailbox:

1. Use a **separate Google Cloud project** whose OAuth audience is **External**.
   Audience is a project-level setting, so a second client in the Internal
   project cannot authorize a personal Gmail account.
2. Enable **Gmail API**, configure the application's branding and contact details,
   and add `gmail.readonly` under **Data Access**.
3. If the app is in **Testing**, add the personal Gmail address as a test user.
4. Create a **Desktop app** client, download its JSON, and save it as the ignored
   `.local/gmail-personal-client.json`, with mode `600`.

External applications left in Testing receive refresh tokens that normally
expire after seven days with Gmail scopes. That is suitable for a temporary
historical connection; reconnect if needed until the historical import finishes.
For ongoing personal-account access, complete the applicable Google production
setup instead of relying on a test token. Workspace Internal connections do not
have that testing-mode seven-day limit, but access can still be revoked.

Desktop OAuth clients use a local callback automatically. If you choose a **Web
application** client instead, register this exact redirect URI and download the
updated client JSON:

```text
http://127.0.0.1:8765/oauth/callback
```

## 4. Authorize each mailbox from the laptop

Run the following from the Carbon checkout, replacing the synthetic mailbox:

```sh
python3 contrib/deploying/gcp-tailscale/gmail-connect.py \
  --client contrib/deploying/gcp-tailscale/.local/gmail-workspace-client.json \
  --email billing@example.com
```

The command opens Google sign-in in your browser. Select that mailbox and allow
read-only Gmail access. Return to the terminal after consent. The helper checks
the actual Gmail identity and saves its refresh token into the ignored secrets
file under `GMAIL_ACCOUNTS_JSON`, preserving your other secrets and mailboxes.
It does not print the token. Repeat with the personal client JSON and personal
email address for the second mailbox.

The mailbox must be an actual Gmail user account. A Google Group or email alias
cannot independently sign in to Gmail OAuth; authorize the mailbox receiving its
delivered copies instead. No domain-wide delegation is needed.

## 5. Deploy and enable

1. Run `make deploy` from the clean `saturn/main` branch after the feature has
   been merged, following the normal fork workflow.
2. Open **Invoicing → Mercury payments**.
3. Check that Mercury and the intended mailboxes appear configured.
4. Enable **Hourly sync** and **Find invoice emails**. Leave **Pause** unchecked
   for the mailboxes you want to search, then choose **Save sync settings**.
   Leave **Import history from** blank for all history.
5. The scheduled job runs at the start of each UTC hour. Review its last run and
   any connection errors on the same screen. Historical imports can span runs.
6. Review proposed vendor names, email evidence, PDFs, and the payment status.
   Choose an existing supplier or approve a new one, then create the draft invoice.
   If the invoice already exists, link it instead. Multiple payments can link to
   the same invoice, which avoids duplicate drafts for partial payments.

The imported payment amount is bank evidence, not an inferred invoice line total.
Use **Invoicing → Document inbox** to review document line items, suppliers, item
types and purchase units before creating or enriching a draft. Importing payment
evidence does not itself settle or post an invoice. There is no automatic bank
account assignment or invented exchange rate. This connector currently uses the
USD bank amount Mercury exposes; a company using another base currency needs a
verified exchange-rate workflow before draft creation. An existing invoice can
still be linked when its currency matches the payment evidence.

## Existing payment history and document review

1. Let the Mercury payment import finish first. Its history cursor and hourly
   collection work independently from document parsing.
2. Open **Invoicing → Document inbox** and save the intake settings. Automatic
   Mercury intake registers newly collected evidence; inference has its own
   enable switch and daily/monthly cost limits.
3. Start the historical document backfill explicitly. It snapshots the current
   history boundary, processes 100 saved payments per page, and saves progress
   after each committed source registration. Pause and resume retain that cursor.
   Starting again after completion includes later payments without creating
   duplicate source identities.
4. Payments without a supporting file appear as **Needs document**. Upload the
   missing receipt, or use **Find supporting document again** on the Mercury
   payment. The latter searches only currently enabled mailboxes and requires
   hourly synchronization to be enabled. It can search a previously reviewed
   payment without replacing its confirmed supplier or invoice link.
5. Review parsed facts and select or propose each supplier and item. Confirm the
   item type, quantities, purchasing units, conversion factors, prices and taxes.
   Approval creates or enriches a **Draft**. Existing populated drafts require an
   explicit line comparison; existing non-Draft invoices receive evidence only.
   Ignored payments stay ignored until explicitly restored.

If a document backfill fails, correct its reported source or access problem and
resume it. Already registered evidence is retained. Bank synchronization continues
while document inference is disabled or unavailable. Posting an invoice, receiving
inventory and recording settlement remain separate existing workflows.

## Move future matching to a purchasing mailbox

1. Create a real Google Workspace user mailbox for purchasing.
2. Run `gmail-connect.py` again with the Workspace OAuth client and that mailbox.
3. Run `make deploy` to deliver the new credential.
4. In the Mercury page, enable the purchasing mailbox and pause the old mailboxes.
   Existing imported evidence and vendor mappings remain available.
5. Once historical matching is complete, remove the old mailbox entries from the
   ignored `GMAIL_ACCOUNTS_JSON` array and deploy again; revoke their Google
   grants if the credentials are no longer needed.

## Matching and privacy

The matcher combines invoice references, amount and currency, recipient identity,
and date proximity. It uses invoice totals rather than a coincidental line-item
price when a total is present. Email matching extracts PDF text locally using the
existing PDF library. The separate document-intake inference feature sends selected
private receipt bytes to the configured managed provider only when enabled; consult
the inference setup guide for its region, limits and cost controls. Scanned images
can be parsed there. Forwarded emails and competing matches
remain ambiguous rather than becoming silent supplier merges.

Searches are bounded to 200 candidate messages per payment per mailbox. If this
limit is reached, or a mailbox cannot be read, the result is marked incomplete
for review. Only candidates with vendor evidence are copied into company storage.
Downloaded files are limited to 10 MiB each, checked by content type, and stored
under company-scoped private object paths. Public source and test fixtures never
contain actual payment, invoice, or mailbox contents.

Pausing stops subsequent provider requests after the short control-check interval;
an already-started request may finish. Mercury imports continue if Gmail needs
reconnection. Re-run the authorization helper for that mailbox and redeploy.

References: [Mercury token setup](https://docs.mercury.com/docs/getting-started),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Google offline OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).
