import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";
import type { IntakeEvidence } from "../intake.models";

/**
 * The source, page by page, beside the proposed fields. The parser returns
 * text evidence anchored to page numbers (and an optional region), never page
 * images, so this is labelled as extracted text rather than a facsimile.
 */
export function SourcePreview({
  evidence,
  activeField,
  fieldLabel
}: {
  evidence: IntakeEvidence[];
  activeField?: string;
  fieldLabel: (field: string) => string;
}) {
  const { t } = useLingui();
  const active = useRef<HTMLElement>(null);
  useEffect(() => {
    if (activeField) active.current?.scrollIntoView({ block: "nearest" });
  }, [activeField]);
  const pages = [...new Set(evidence.map((entry) => entry.page))].sort(
    (a, b) => a - b
  );
  let highlighted = false;
  return (
    <aside aria-label={t`Source evidence`} className="source-preview">
      <h2>
        <Trans>Source pages</Trans>
      </h2>
      <p className="source-preview-note">
        <Trans>
          Extracted text anchored to page numbers. Page images are not available
          for this document; download the original to see the layout.
        </Trans>
      </p>
      {pages.length === 0 ? (
        <p>
          <Trans>No text has been extracted yet.</Trans>
        </p>
      ) : null}
      {pages.map((page) => (
        <section
          aria-label={t`Page ${page}`}
          className="source-page"
          key={page}
        >
          <h3>
            <Trans>Page {page}</Trans>
          </h3>
          {evidence
            .filter((entry) => entry.page === page)
            .map((entry, index) => {
              const isActive = activeField === entry.field;
              const ref = isActive && !highlighted ? active : undefined;
              if (isActive) highlighted = true;
              return (
                <article
                  className={`source-excerpt${isActive ? " source-excerpt-active" : ""}`}
                  key={`${entry.field}-${page}-${index}`}
                  ref={ref}
                >
                  <span className="source-excerpt-field">
                    {fieldLabel(entry.field)}
                    {entry.region ? ` · ${entry.region}` : ""}
                  </span>
                  <p>{entry.text}</p>
                </article>
              );
            })}
        </section>
      ))}
    </aside>
  );
}
