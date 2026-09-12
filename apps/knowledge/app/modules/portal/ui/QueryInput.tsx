import type { QueryResult } from "@carbon/knowledge/query";
import { isStepUpRequiredBody } from "@carbon/knowledge/step-up";
import { useEffect, useState } from "react";
import { EvidenceCard } from "./EvidenceCard";

async function requiresStepUp(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    return isStepUpRequiredBody(await response.json());
  } catch {
    return false;
  }
}

export function QueryInput({
  sourceDisplayName
}: {
  sourceDisplayName: string;
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<QueryResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  // Results are private to one company and one signed-in person. The route
  // remounts this component when the company scope changes (`key={scope}`),
  // and a page restored from the back-forward cache after a sign-out drops
  // them here, so a later visitor at the same browser never sees them.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setResult(undefined);
        setError(undefined);
        setText("");
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

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
      if (!response.ok) {
        if (await requiresStepUp(response)) {
          // A document navigation: the step-up page is server-rendered with
          // a 403 status and needs no client-side router state.
          window.location.assign("/step-up");
          return;
        }
        throw new Error("Manual search is unavailable.");
      }
      setResult((await response.json()) as QueryResult);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Manual search is unavailable."
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <form className="query-form" onSubmit={submit}>
        <label htmlFor="knowledge-query">Search manuals</label>
        <input
          id="knowledge-query"
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
          placeholder="Manufacturer, part number, revision, machine, or keyword"
          type="search"
          value={text}
        />
        <button disabled={pending || !text.trim()} type="submit">
          {pending ? "Searching…" : "Search manuals"}
        </button>
      </form>
      <a className="upload-link" href="/intake">
        Upload a manual
      </a>
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <section aria-live="polite" className="query-result">
          {result.evidence.length === 0 ? (
            <p>No matching manuals found.</p>
          ) : null}
          {result.partial ? (
            <p>Some authorized manuals were unavailable.</p>
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
