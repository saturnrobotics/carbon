# Portal intake review interface (plan Task 14)

Concise record of the decisions behind `apps/portal` intake and review.

## Decisions

- **URL intake is acquired at capture, not by the processor.** The worker's
  `POST /v1/intake` accepts `sourceUrl` and fetches it synchronously through the
  existing `fetchBoundedUrl` policy, then stores the bytes as an immutable object
  exactly like a file upload, recording `acquiredFrom` on the input reference.
  The manual release profile requires an immutable object before extraction,
  and this keeps acquisition failures (HTTPS-only, private address, size,
  content type) reportable on the upload page, separate from extraction state.
- **Library selection is server-bounded.** `GET /v1/sources/writable` lists the
  active upload sources the actor's read grant allows capture into, restricted
  to the configured manual library in this release. A `sourceId` outside that
  list is refused (403). A caller who can list nothing still sees the form; the
  worker refuses the attempt and the page names the refusal.
- **Item candidates go through the query gateway.** `POST /v1/items` on the
  query service calls the registered Carbon `resolveItems` operation via the
  source registry transport (deadline, byte and operation limits unchanged).
  The manual release registers no Carbon source, so the handler answers
  `unavailable` and the reviewer can still publish a generic document. The
  local Docker fixture registers a synthetic carbon source whose only stubbed
  pieces are the outbound socket and forwarding headers.
- **The item association lives on the review, not as an entity link.** It is
  stored as `reviewDecisions.item` (bounded identity: id, readableId, name,
  revision, mpn; `null` is an explicit "generic document"). The review role
  cannot insert `portal.entity` rows and no Carbon entity projection exists
  in the manual release, so a verified `entityLink` is left to the linking layer.
  Publication ignores the field; nothing is posted or created in Carbon.
- **Source-page preview is text anchored to pages.** The parser output carries
  no page images, only `{page, region?, text}` evidence, so the review page
  shows extracted text grouped by page, labelled as such, and highlights the
  excerpts for the focused field.
- **Lingui without `@carbon/locale`.** The portal uses `@lingui/react/macro`
  and a `portal` catalog in the root `lingui.config.js`, with a small local
  `LocaleProvider` and `Accept-Language` resolution. `@carbon/locale` reads its
  defaults through `@carbon/env`, the ERP runtime environment module, which this
  separately deployed app does not carry. `Dockerfile.web` copies
  `lingui.config.js` because `turbo prune` omits it and the Vite plugin fails
  without it.
- **No `react-dropzone`.** The dropzone is a native drag handler around the
  form's own file input, so an unhydrated submission and keyboard users work,
  and the app takes no shared UI dependency.

## Verified

- `pnpm --filter portal test`, `--filter portal-worker test`,
  `--filter portal-query test`, `--filter @carbon/portal test`
- `pnpm exec turbo run typecheck` for the four portal packages
- `pnpm --filter portal test:e2e -- intake` against the local Docker stack
  (see the PR for the run record)

## Not done

- Translations for the 12 non-source locales are extracted but empty; run
  `pnpm translate` when the strings settle.
- A verified `portal.entityLink` for the associated item (see above).
