import type { Evidence } from "@carbon/knowledge";
import type { QueryResult } from "@carbon/knowledge/query/result";
import {
  createLineSplitter,
  decodeQueryStreamLine,
  QUERY_STREAM_MEDIA_TYPE,
  type QueryStreamEvent
} from "@carbon/knowledge/query/stream";
import { isStepUpRequiredBody } from "@carbon/knowledge/step-up";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { EvidenceCard, evidenceAnchor } from "./EvidenceCard";

/**
 * The refusal class the gateway named, or unavailability when it named none.
 *
 * The body is read once: `response.json()` consumes it, and the step-up check
 * and the message the reader sees both need that read.
 */
async function denialCode(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return "query_unavailable";
  }
  if (response.status === 403 && isStepUpRequiredBody(body))
    return "step_up_required";
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
    ? code
    : "query_unavailable";
}

type Progress = Extract<QueryStreamEvent, { type: "progress" }>;

/** Message the service attaches when no evidence was found; the UI has its own copy. */
const NO_EVIDENCE_MESSAGE = "No authorized evidence was found.";

export function QueryInput({
  sourceDisplayName
}: {
  sourceDisplayName: string;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [result, setResult] = useState<QueryResult>();
  const [progress, setProgress] = useState<Progress>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  // The follow-up context is one opaque id; the service keeps the evidence
  // references it names and re-authorizes them on every reuse.
  const conversationRef = useRef<string>();

  function reset() {
    setEvidence([]);
    setResult(undefined);
    setProgress(undefined);
    setError(undefined);
  }

  // Results are private to one company and one signed-in person. The route
  // remounts this component when the company scope changes (`key={scope}`),
  // and a page restored from the back-forward cache after a sign-out drops
  // them here, so a later visitor at the same browser never sees them.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setEvidence([]);
        setResult(undefined);
        setProgress(undefined);
        setError(undefined);
        setText("");
        conversationRef.current = undefined;
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  function describeError(code: string): string {
    if (code === "authorization_changed")
      return t`Your access changed while this request ran. Search again.`;
    if (code === "request_deadline_exceeded")
      return t`The request did not complete within its time budget.`;
    // A refusal is not an outage, and telling a reader to try again later when
    // the answer will not change is the defect this names. The wording is the
    // portal's existing copy for `forbidden`, and says nothing about what
    // exists — only that this reader may not have it.
    if (code === "forbidden")
      return t`You do not have permission for this action in this library.`;
    if (code === "unauthorized")
      return t`You are not signed in to this library, or your access was revoked.`;
    return t`Manual search is unavailable.`;
  }

  function applyEvent(event: QueryStreamEvent) {
    if (event.type === "progress") setProgress(event);
    else if (event.type === "evidence") setEvidence(event.evidence);
    else if (event.type === "result") {
      setResult(event.result);
      setEvidence(event.result.evidence);
    } else {
      // A failure after evidence was shown withdraws it: what the reader
      // sees is only ever a delivered result.
      setEvidence([]);
      setResult(undefined);
      setError(describeError(event.error));
    }
  }

  async function readStream(body: ReadableStream<Uint8Array>) {
    const reader = body.pipeThrough(createLineSplitter()).getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const event = decodeQueryStreamLine(next.value);
      if (event) applyEvent(event);
    }
  }

  async function ask(question: string, entityId?: string) {
    if (!question) return;
    setPending(true);
    reset();
    if (!conversationRef.current) conversationRef.current = crypto.randomUUID();
    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: {
          accept: `${QUERY_STREAM_MEDIA_TYPE}, application/json`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          text: question,
          mode: "auto",
          locale: navigator.language || "en-US",
          context: {
            conversationId: conversationRef.current,
            ...(entityId ? { entityId } : {})
          }
        })
      });
      if (!response.ok) {
        const denial = await denialCode(response);
        if (denial === "step_up_required") {
          // A document navigation: the step-up page is server-rendered with
          // a 403 status and needs no client-side router state.
          window.location.assign("/step-up");
          return;
        }
        setEvidence([]);
        setResult(undefined);
        setError(describeError(denial));
        return;
      }
      if (
        response.body &&
        response.headers
          .get("content-type")
          ?.startsWith(QUERY_STREAM_MEDIA_TYPE)
      ) {
        await readStream(response.body);
      } else {
        const parsed = (await response.json()) as QueryResult;
        setResult(parsed);
        setEvidence(parsed.evidence);
      }
    } catch {
      setEvidence([]);
      setResult(undefined);
      setError(t`Manual search is unavailable.`);
    } finally {
      setPending(false);
      setProgress(undefined);
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(text.trim());
  }

  function choose(choice: { id: string; label: string }) {
    void ask(text.trim(), choice.id);
  }

  function startOver() {
    conversationRef.current = undefined;
    reset();
    setText("");
  }

  const citationIndex = new Map(evidence.map((item, at) => [item.id, at + 1]));
  const progressText = progress
    ? progress.stage === "synthesis"
      ? t`Composing an answer from ${evidence.length} evidence blocks…`
      : progress.state === "partial"
        ? t`Some sources did not answer; results may be partial.`
        : t`Searching authorized sources…`
    : undefined;
  const serviceMessage =
    result?.message && result.message !== NO_EVIDENCE_MESSAGE
      ? result.message
      : undefined;

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
      {progressText ? (
        <p className="query-progress" role="status">
          {progressText}
        </p>
      ) : null}
      {result || evidence.length ? (
        <section aria-live="polite" className="query-result">
          {result?.kind === "clarification" && result.choices?.length ? (
            <div className="choice-list" role="group" aria-label={t`Choices`}>
              <p>{result.message}</p>
              {result.choices.map((choice) => (
                <button
                  disabled={pending}
                  key={choice.id}
                  onClick={() => choose(choice)}
                  type="button"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          ) : serviceMessage ? (
            <p className="query-message">{serviceMessage}</p>
          ) : null}
          {result?.kind === "answer" ? (
            <ol className="answer-claims" aria-label={t`Answer`}>
              {result.claims.map((claim, at) => (
                <li key={`${at}-${claim.evidenceIds.join(",")}`}>
                  {claim.text}{" "}
                  {claim.evidenceIds.map((id) => {
                    const source = evidence.find((item) => item.id === id);
                    const number = citationIndex.get(id);
                    if (!source || !number) return null;
                    return (
                      <a
                        className="citation"
                        href={source.sourceUri}
                        key={id}
                        rel="noreferrer"
                        title={
                          source.page
                            ? `${source.title} · ${t`page ${source.page}`}`
                            : source.title
                        }
                      >
                        [{number}]
                      </a>
                    );
                  })}{" "}
                  {claim.evidenceIds.map((id) =>
                    citationIndex.has(id) ? (
                      <a
                        className="citation-anchor"
                        href={`#${evidenceAnchor({ id })}`}
                        key={`anchor-${id}`}
                      >
                        <Trans>see evidence</Trans>
                      </a>
                    ) : null
                  )}
                </li>
              ))}
            </ol>
          ) : null}
          {result &&
          evidence.length === 0 &&
          result.kind !== "clarification" ? (
            <p>
              <Trans>No matching manuals found.</Trans>
            </p>
          ) : null}
          {result?.partial ? (
            <p>
              <Trans>Some authorized manuals were unavailable.</Trans>
            </p>
          ) : null}
          <div className="evidence-grid">
            {evidence.map((item, at) => (
              <EvidenceCard
                evidence={item}
                index={at + 1}
                key={item.id}
                sourceDisplayName={sourceDisplayName}
              />
            ))}
          </div>
          {result ? (
            <p className="conversation-note">
              <Trans>
                A follow-up question keeps the evidence shown here in context.
              </Trans>{" "}
              <button onClick={startOver} type="button">
                <Trans>Start a new question</Trans>
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
