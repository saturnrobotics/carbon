# Localization and Swagger verification repairs

These repairs continue the safeguards candidate based on `6b5f5c5944`; the stable
integration branch and dependency resolutions are unchanged.

The localization guards now inspect imports and JSX syntax. Message descriptors,
provider-bound translation hooks, and translated JSX remain valid; global
translation calls and raw labels remain failures. Customer tax status and both
values use `Trans`, with translations in all thirteen configured ERP catalogs.
The browser regression exercises the actual locale provider, a production message
descriptor, memoized labels, and translated JSX across English, Spanish, and back,
while retaining component state. It is a required application CI command separate
from the browser-independent unit suite.

Translation completeness is a separate required source check (`linguito check`).
Compilation alone had accepted older missing batch-release messages and a
malformed Japanese entry. All 37 older gaps are filled, preserving placeholders
and other authored translations; the completeness check and compilation pass.

The additional read-only source-coverage check uses the pinned Lingui extractor
and verifies every current message ID in every configured locale. It rejects
missing or obsolete active entries, failed extraction, and empty extraction.
Required regression tests also compare configured locales with runtime language
choices. All 7,085 source messages are covered across two catalogs and thirteen
locales, with catalog bytes unchanged. The standalone suite now passes 104 tests,
including ten coverage regressions. Explicit-ID message wording still requires
translation review; ID coverage does not prove translated text is correct.

Swagger generation verifies the complete known `partners` view definition and its
ordered `(id, abilityId)` source key using Studio's catalog-query endpoint. Only
the known duplicate-alias primary-key annotation is normalized. The generated
diff changes two descriptions; foreign-key notes and all other contract metadata
remain intact. Changed proof assumptions or malformed responses fail before the
atomic output replacement. A future view change requires review of this narrowly
scoped compatibility correction. No historical migration or platform pin changed.

Swagger comparison decodes literal data from the TypeScript export using its AST.
Quote choice, object-key order, and array layout are formatting; description
contents and array order remain significant. Executable expressions and duplicate
keys are rejected. The same literal comparison is used for fresh, upgrade, and
committed output, without evaluating generated JavaScript.

The registry and CI include the helper, SQL proof, and regression tests. The
disposable runner uses its own metadata service for the proof and rejects other
queries and project paths. Its revision checks additionally reject a candidate
used as its own upgrade baseline and deleted committed generation inputs.

Before promotion, require the final candidate's full ERP suite, standalone
generator tests, browser locale regression, scoped typechecks, strict lint,
generation comparison, and fresh/upgrade schema comparison. The root safeguards
plan records progress; local raw evidence stays ignored. Remote `fork-verified`
must still succeed for the exact promoted SHA.

Local verification of `67a0aed1c8` passed: 1,016 ERP unit tests, the real browser
locale switch, 94 standalone generator/wiring tests, 111 safeguard tests, scoped
typechecks and strict lint, frozen installation, translation completeness,
repeated generation, and strict disposable fresh/upgrade comparison against the
committed artifacts. Both database paths apply all 1,000 migrations and repeat
artifact generation. Allocated resources were removed. The branch is unpromoted
pending the required remote verification.
