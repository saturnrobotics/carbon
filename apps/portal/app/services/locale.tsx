import { type Messages, setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { type ReactNode, useMemo } from "react";

/** Mirrors `lingui.config.js`. The portal keeps its own copy instead of
 * depending on `@carbon/locale`, whose language table is read through the ERP
 * runtime environment module; this app is deployed with a different one. */
export const supportedLanguages = [
  "en",
  "es",
  "de",
  "it",
  "ja",
  "zh",
  "fr",
  "pl",
  "pt",
  "ru",
  "hi",
  "tr",
  "ko"
] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export function resolveLanguage(
  locale: string | null | undefined
): SupportedLanguage {
  const normalized = locale?.trim().toLowerCase().split(/[-_]/)[0];
  return supportedLanguages.includes(normalized as SupportedLanguage)
    ? (normalized as SupportedLanguage)
    : "en";
}

/** First supported language in `Accept-Language`, by declared preference. */
export function languageFromRequest(request: Request): SupportedLanguage {
  const header = request.headers.get("accept-language") ?? "";
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));
      const weight = quality ? Number(quality.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of ranked) {
    const language = entry.tag.toLowerCase().split(/[-_]/)[0];
    if (supportedLanguages.includes(language as SupportedLanguage))
      return language as SupportedLanguage;
  }
  return "en";
}

/** The only active Lingui runtime, built per render like `@carbon/locale`. */
export function LocaleProvider({
  language,
  catalog,
  children
}: {
  language: SupportedLanguage;
  catalog?: Messages;
  children: ReactNode;
}) {
  const i18n = useMemo(() => {
    const runtime = setupI18n();
    runtime.load(language, catalog ?? {});
    runtime.activate(language);
    return runtime;
  }, [catalog, language]);
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
