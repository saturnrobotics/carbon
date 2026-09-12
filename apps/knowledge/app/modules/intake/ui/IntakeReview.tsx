import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import {
  displayField,
  type IntakeReviewModel,
  type ItemAssociation,
  type ManualMetadata,
  manualMetadataFields
} from "../intake.models";
import { ItemCandidates } from "./ItemCandidates";
import { SourcePreview } from "./SourcePreview";

export function IntakeReview({
  model,
  error
}: {
  model: IntakeReviewModel;
  /** Worker error code from the last save or publish attempt. */
  error?: string;
}) {
  const { t } = useLingui();
  const labels: Record<keyof ManualMetadata, string> = {
    title: t`Title`,
    manufacturer: t`Manufacturer`,
    partNumber: t`Part number`,
    revision: t`Revision`,
    machine: t`Machine`
  };
  const fieldLabel = (field: string) =>
    field in labels ? labels[field as keyof ManualMetadata] : field;
  const initial = useMemo(
    () =>
      Object.fromEntries(
        manualMetadataFields.map((field) => [field, displayField(model, field)])
      ) as Record<keyof ManualMetadata, string>,
    [model]
  );
  const [values, setValues] = useState(initial);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [item, setItem] = useState<ItemAssociation | null>(model.item);
  const [activeField, setActiveField] = useState<string>();
  const unresolved = model.unresolved.filter(
    (field) => !acknowledged.includes(field)
  );
  const readOnly = model.published;
  const canPublish =
    !readOnly && unresolved.length === 0 && model.state === "ready";

  const stateCopy: Record<IntakeReviewModel["state"], [string, string]> = {
    captured: [
      t`Captured`,
      t`The document is stored and waiting for extraction.`
    ],
    extracting: [t`Extracting`, t`Text is being extracted from the document.`],
    "needs-review": [
      t`Needs review`,
      t`Proposed fields are ready. Confirm or correct them, then save.`
    ],
    ready: [
      t`Reviewed`,
      t`Corrections are saved. The document can be published.`
    ],
    failed: [
      t`Extraction failed`,
      t`The document was captured, but text could not be extracted. Review cannot start until extraction succeeds.`
    ]
  };
  const [stateLabel, stateHelp] = readOnly
    ? [t`Published`, t`This review was published; it is now read-only.`]
    : stateCopy[model.state];

  const errors: Record<string, string> = {
    version_conflict: t`This document changed since you opened it, or the same content was already reviewed. Reload and check before saving again.`,
    invalid_request: t`The review could not be saved. Check the fields and unresolved evidence.`,
    unauthorized: t`You are not allowed to review documents in this library.`,
    forbidden: t`You are not allowed to publish in this library. The review was kept.`,
    service_unavailable: t`The review service is unavailable. Nothing was changed.`
  };

  return (
    <section aria-label={t`Intake review`} className="review-layout">
      <div className="review-main">
        <p
          className={`review-state review-state-${readOnly ? "published" : model.state}`}
        >
          <Trans>State:</Trans> <strong>{stateLabel}</strong>
          <span className="review-state-help">{stateHelp}</span>
        </p>
        {model.acquiredFrom ? (
          <p className="review-provenance">
            <Trans>Fetched from</Trans>{" "}
            <a href={model.acquiredFrom} rel="noreferrer">
              {model.acquiredFrom}
            </a>
          </p>
        ) : null}
        <h2>{model.title || t`Captured document`}</h2>
        <form method="post">
          <input
            name="expectedVersion"
            type="hidden"
            value={model.version ?? ""}
          />
          <input
            name="expectedGeneration"
            type="hidden"
            value={model.generation ?? ""}
          />
          <input
            name="requestId"
            type="hidden"
            value={`intake-${model.id}-${model.generation ?? "current"}`}
          />
          <input name="metadata" type="hidden" value={JSON.stringify(values)} />
          <input
            name="unresolved"
            type="hidden"
            value={JSON.stringify(unresolved)}
          />
          <fieldset className="review-fields" disabled={readOnly}>
            <legend>
              <Trans>Proposed fields</Trans>
            </legend>
            {manualMetadataFields.map((field) => {
              const evidenceCount = model.evidence.filter(
                (entry) => entry.field === field
              ).length;
              const changed = model.unresolved.includes(field);
              const corrected = field in model.corrected;
              return (
                <div
                  className={`review-field${activeField === field ? " review-field-active" : ""}`}
                  key={field}
                >
                  <label>
                    {labels[field]}
                    <input
                      aria-describedby={
                        changed ? `${field}-unresolved` : undefined
                      }
                      maxLength={field === "title" ? 500 : 256}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field]: event.target.value
                        }))
                      }
                      onFocus={() => setActiveField(field)}
                      required={field === "title"}
                      value={values[field] ?? ""}
                    />
                  </label>
                  <span className="review-field-meta">
                    {corrected ? (
                      <span className="review-badge">
                        <Trans>Saved correction</Trans>
                      </span>
                    ) : null}
                    {model.proposed[field] !== undefined &&
                    corrected &&
                    model.proposed[field] !== model.corrected[field] ? (
                      <span>
                        <Trans>Proposed: {model.proposed[field]}</Trans>
                      </span>
                    ) : null}
                    {evidenceCount > 0 ? (
                      <button
                        aria-pressed={activeField === field}
                        className="review-evidence-button"
                        onClick={() =>
                          setActiveField((current) =>
                            current === field ? undefined : field
                          )
                        }
                        type="button"
                      >
                        <Trans>Show evidence ({evidenceCount})</Trans>
                      </button>
                    ) : (
                      <span>
                        <Trans>No evidence on any page</Trans>
                      </span>
                    )}
                  </span>
                  {changed ? (
                    <small
                      className="review-unresolved"
                      id={`${field}-unresolved`}
                    >
                      <Trans>
                        New evidence changed this field after it was reviewed.
                      </Trans>{" "}
                      <label>
                        <input
                          checked={acknowledged.includes(field)}
                          onChange={(event) =>
                            setAcknowledged((current) =>
                              event.target.checked
                                ? [...current, field]
                                : current.filter((value) => value !== field)
                            )
                          }
                          type="checkbox"
                        />
                        <Trans>I reviewed this evidence</Trans>
                      </label>
                    </small>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
          <ItemCandidates
            decided={model.itemDecided}
            disabled={readOnly}
            onChange={setItem}
            value={item}
          />
          <div className="review-actions">
            <button
              disabled={readOnly}
              name="intent"
              type="submit"
              value="review"
            >
              <Trans>Save review</Trans>
            </button>
            <button
              disabled={!canPublish}
              name="intent"
              type="submit"
              value="publish"
            >
              <Trans>Publish manual</Trans>
            </button>
            {!canPublish && !readOnly ? (
              <span className="review-actions-help">
                {unresolved.length > 0
                  ? t`Acknowledge the changed evidence before publishing.`
                  : t`Save the review before publishing.`}
              </span>
            ) : null}
          </div>
          {error ? (
            <p role="alert">{errors[error] ?? errors.service_unavailable}</p>
          ) : null}
        </form>
      </div>
      <SourcePreview
        activeField={activeField}
        evidence={model.evidence}
        fieldLabel={fieldLabel}
      />
    </section>
  );
}
