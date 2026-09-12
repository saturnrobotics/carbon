import type { QueryResult } from "@carbon/knowledge/query";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { EvidenceCard } from "./EvidenceCard";

export function QueryInput({
  sourceDisplayName
}: {
  sourceDisplayName: string;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const [result, setResult] = useState<QueryResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = text.trim();
    if (!query) return;
    setPending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          text: query,
          mode: "locate",
          locale: navigator.language || "en-US"
        })
      });
      if (!response.ok) throw new Error("unavailable");
      setResult((await response.json()) as QueryResult);
    } catch {
      setError(t`Manual search is unavailable.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <form className="query-form" onSubmit={submit}>
        <label htmlFor="knowledge-query">
          <Trans>Search manuals</Trans>
        </label>
        <input
          id="knowledge-query"
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
          placeholder={t`Manufacturer, part number, revision, machine, or keyword`}
          type="search"
          value={text}
        />
        <button disabled={pending || !text.trim()} type="submit">
          {pending ? t`Searching…` : t`Search manuals`}
        </button>
      </form>
      <a className="upload-link" href="/intake">
        <Trans>Upload a manual</Trans>
      </a>
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <section aria-live="polite" className="query-result">
          {result.evidence.length === 0 ? (
            <p>
              <Trans>No matching manuals found.</Trans>
            </p>
          ) : null}
          {result.partial ? (
            <p>
              <Trans>Some authorized manuals were unavailable.</Trans>
            </p>
          ) : null}
          <div className="evidence-grid">
            {result.evidence.map((evidence) => (
              <EvidenceCard
                evidence={evidence}
                key={evidence.id}
                sourceDisplayName={sourceDisplayName}
              />
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
