# Invoice document review and approval

Last tested: 2026-09-07
Route: `/x/invoicing/documents`

## Prerequisites

- An isolated, migrated local database and local Supabase auth/storage services.
- A synthetic employee with invoicing create/update/view and supplier/item creation permissions.
- Company currency USD, unit EA, and an invoice/inventory location.
- For generated material IDs, existing synthetic substance and shape records.
- A synthetic PDF or PNG receipt, stored with screenshots and browser state in an ignored local artifact directory.

## Upload and manually review

1. Open Invoice documents. Select the file input labeled **Invoice document**, using an absolute file path. Submit the form with **Upload and review**.
2. Verify the review route, original-document preview, and **Open original document** link. This flow also works when automatic parsing is disabled.
3. Enter an invoice number and save an incomplete review. Verify the saved reference and **Needs review** status.
4. Use **Propose new supplier**. Enter a synthetic name in the native Supplier form, then submit **Use proposal**. Save the review. Verify the supplier table count is unchanged.
5. Set document kind Receipt, invoice date, USD, and invoice location. Enter subtotal 10, discounts 0, tax 0, shipping 0, and total 10. Confirm the tax/discount/shipping checkbox.
6. Add one line: description `Consumable test washers`, type Consumable, quantity 2, net unit price 5, source line total 10, purchase unit EA, inventory unit EA, and an inventory location. Set the conversion factor to 1 after selecting both units. Enter explicit zero discount, tax, tax percent, and shipping.
7. Open **Propose new item**, enter a synthetic ID, and close the drawer. Verify no item was created. Reopen it, enter the ID, submit **Use proposal**, and save the review.
8. Verify **Ready**, the proposed supplier/item labels, and the planned creation counts. Supplier, item, and invoice table counts must still match their baseline.
9. Click **Approve and create draft**. Verify **Approved**, **Open invoice**, one new supplier, one new item, and one Draft purchase invoice. Inventory ledger counts must be unchanged.

## Other item forms

Use another synthetic receipt and an unapproved review. Change the line type and submit a proposal through each native form: Part, Material, Tool, Service. Save after each. Verify these actions create no extra item records.

For generated Material IDs, choose the existing Substance and Shape. The generated ID/name and the selected tracking type, replenishment system, method, and inventory unit must all remain in the saved proposal. Complete the receipt fields and approve to verify a Material and a Draft purchase invoice are created.

## Multiple source files

1. Add a different supporting document to an unapproved intake. Verify the source review requires a primary document and a reason for every other distinct file.
2. Select the second file as primary. Save its supporting/exclusion reasons and, when replacing previously parsed facts manually, the explicit manual-review confirmation. Save an invoice reference at the same time.
3. Reload. Verify the primary selection, preview, reasons, and invoice reference persist. Parsing requires the primary choice to have been saved first.
4. Change the primary file. Verify role-dependent reasons clear so a previous exclusion cannot silently become a manual-transcription confirmation.
5. Register a new distinct file against a Ready intake. Verify it returns to Needs review; registering identical bytes from a second channel must preserve Ready.

## Learned repeat and attachment completion

1. Use the real invoice worker with a deterministic synthetic provider response and the canonical ERP validation callback. The first parsed document from an unconfirmed supplier name should remain Needs review.
2. In the browser, select the correct existing supplier and item, save, and approve. Verify a supplier-name rule is now displayed. A manual document without an extracted supplier name does not teach an unsupported supplier alias.
3. Process a new document with the same supplier/item text but a different invoice reference, date, quantity, price, and total. Verify the worker persists Ready and a saved match.
4. Open that document in the browser. Verify the new quantity and price, then approve in one click. Verify a new Draft invoice and unchanged supplier/item counts.
5. Invoke the actual attachment-copy worker against local storage. Verify Complete in the database and that the invoice's copying message disappears. Confirm the protected document metadata and original remain available.
6. Open the native invoice's Files card. Verify the copied filename appears, its signed download returns the original bytes, and it has no delete menu. The empty-files message must be absent. Upload an ordinary file through the existing New control and verify its usual download/delete menu remains available.
7. Open `/x/purchase-invoice/new`, choose an existing synthetic supplier, and save without uploading a receipt. Verify the normal form creates a Draft invoice and does not post inventory.

## Selector notes

- Use the native form's `requestSubmit(submitter)` for **Use proposal** and **Upload and review**. Review action buttons use their normal click handler.
- Blur numeric inputs before moving to the next step. Changing units intentionally clears the old conversion, so enter it after both unit selections.
- Wait for a combobox's exit transition before opening the next one; the closing and opening lists can briefly both exist in the DOM.
- Material reference options include a `Custom` badge in their accessible name. Match the reference name within that accessible name.
- A Playwright date-input fill works after hydration. If a native browser driver exposes Day/Month/Year spin buttons, select each segment explicitly and type its digits.
- Wait for local page hydration before filling. A development server reload can discard unsaved input; do not interpret an unchanged record count as a successful save without checking the request and visible state.

## Verified outcomes

- PDF and PNG upload and original preview.
- Incomplete review save with a reference.
- Supplier and all five item-class proposals save without creating masters.
- Consumable proposal cancellation creates no item.
- Consumable and generated Material approval create Draft invoices with no inventory ledger entries.
- **Open invoice** displays the native invoice detail screen with the selected item, quantity, price, total, source-document link, shipping fields, and properties.
- `/x/sales-rfq/new` retains its normal customer/contact/date/location fields and RFQ PDF dropzone. This smoke test does not send a paid RFQ inference request.
- Deterministic provider response → real extraction worker → canonical ERP validation → Ready → one-click browser approval. New document quantity, unit price, and date remain independent of saved identity rules.
- Actual attachment-copy worker completes and the native invoice's pending attachment message clears.
- Copied receipt appears inside the native Files card; signed download returns HTTP 200 with the expected PNG signature, and no delete menu is offered. An ordinary manual upload still appears with its enabled native Delete menu.
- The normal purchase-invoice creation form saves a new Draft invoice without a receipt. The disposable schema-only restore needed the standard `extensions` schema USAGE grant for authenticated default-ID generation before this baseline workflow could run.
- Multiple-source browser checks confirm explicit primary selection, persisted preview and reasons, preserved invoice fields, Save-before-Parse behavior, and cleared reasons when document roles change. PostgreSQL checks cover final approval, late-file invalidation, and previous-source provenance after failed parsing.
