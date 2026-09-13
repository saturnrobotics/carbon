import type { Messages } from "@lingui/core";
import type { SupportedLanguage } from "./locale";

// Compiled at build time from packages/locale/locales/*/knowledge.po
// (`pnpm lingui:compile`); the source-language strings render when a
// compiled catalog is absent, exactly as in ERP and MES.
const catalogLoaders = import.meta.glob(
  "../../../../packages/locale/locales/*/knowledge.mjs",
  { import: "messages" }
) as Record<string, () => Promise<Messages>>;

export async function loadLinguiCatalog(
  language: SupportedLanguage
): Promise<Messages> {
  const load =
    catalogLoaders[
      `../../../../packages/locale/locales/${language}/knowledge.mjs`
    ];
  return load ? load() : {};
}
