import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { memo, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "../../../../../packages/locale/src/i18n";
import { itemTypeLabel } from "../../../app/components/Form/itemTypeLabel";

const part = itemTypeLabel("Part");
const taxStatus = msg`Tax Status`;
const exempt = msg`Exempt`;
const taxable = msg`Taxable`;
const catalogs = {
  en: {
    [part.id]: "Part",
    [taxStatus.id]: "Tax Status",
    [exempt.id]: "Exempt",
    [taxable.id]: "Taxable"
  },
  es: {
    [part.id]: "Pieza",
    [taxStatus.id]: "Estado fiscal",
    [exempt.id]: "Exento de impuestos",
    [taxable.id]: "Sujeto a impuestos"
  }
};

const Labels = memo(function Labels() {
  const { t, i18n } = useLingui();
  const [count, setCount] = useState(0);
  const heading = useMemo(() => t(taxStatus), [t]);
  return (
    <>
      <p data-testid="descriptor">{i18n._(part)}</p>
      <p data-testid="memoized">{heading}</p>
      <p data-testid="exempt">
        <Trans>Exempt</Trans>
      </p>
      <p data-testid="taxable">
        <Trans>Taxable</Trans>
      </p>
      <button
        type="button"
        data-testid="state"
        onClick={() => setCount(count + 1)}
      >
        {count}
      </button>
    </>
  );
});

function App() {
  const [locale, setLocale] = useState<"en" | "es">("en");
  return (
    <>
      <button type="button" onClick={() => setLocale("en")}>
        en
      </button>
      <button type="button" onClick={() => setLocale("es")}>
        es
      </button>
      <LocaleProvider locale={locale} catalog={catalogs[locale]}>
        <Labels />
      </LocaleProvider>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Localization fixture root is missing");
createRoot(root).render(<App />);
