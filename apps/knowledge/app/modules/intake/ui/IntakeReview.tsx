import { useMemo, useState } from "react";
import type { IntakeReviewModel } from "../intake.models";
import { displayField } from "../intake.models";

const fields = [
  ["title", "Title"],
  ["manufacturer", "Manufacturer"],
  ["partNumber", "Part number"],
  ["revision", "Revision"],
  ["machine", "Machine"]
] as const;

export function IntakeReview({ model }: { model: IntakeReviewModel }) {
  const initial = useMemo(
    () =>
      Object.fromEntries(
        fields.map(([field]) => [field, displayField(model, field)])
      ),
    [model]
  );
  const [values, setValues] = useState(initial);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const unresolved = model.unresolved.filter(
    (field) => !acknowledged.includes(field)
  );
  return (
    <section aria-label="Intake review">
      <p>
        State: <strong>{model.state}</strong>
      </p>
      <h2>{model.title}</h2>
      <form method="post">
        <input
          type="hidden"
          name="expectedVersion"
          value={model.version ?? ""}
        />
        <input
          type="hidden"
          name="expectedGeneration"
          value={model.generation ?? ""}
        />
        <input
          type="hidden"
          name="requestId"
          value={`intake-${model.id}-${model.generation ?? "current"}`}
        />
        <input type="hidden" name="metadata" value={JSON.stringify(values)} />
        <input
          type="hidden"
          name="unresolved"
          value={JSON.stringify(unresolved)}
        />
        {fields.map(([field, label]) => (
          <label key={field}>
            {label}
            <input
              maxLength={field === "title" ? 500 : 256}
              required={field === "title"}
              value={values[field] ?? ""}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [field]: event.target.value
                }))
              }
              aria-describedby={
                model.unresolved.includes(field)
                  ? `${field}-unresolved`
                  : undefined
              }
            />
            {model.unresolved.includes(field) && (
              <small id={`${field}-unresolved`}>
                New evidence changed this field.{" "}
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledged.includes(field)}
                    onChange={(event) =>
                      setAcknowledged((current) =>
                        event.target.checked
                          ? [...current, field]
                          : current.filter((value) => value !== field)
                      )
                    }
                  />
                  I reviewed this evidence
                </label>
              </small>
            )}
          </label>
        ))}
        <button name="intent" value="review" type="submit">
          Save review
        </button>
        <button
          name="intent"
          value="publish"
          type="submit"
          disabled={unresolved.length > 0 || model.state !== "ready"}
        >
          Publish manual
        </button>
      </form>
      <aside aria-label="Source evidence">
        {model.sourcePages.map((page) => (
          <p key={page.page}>
            Page {page.page}: {page.text}
          </p>
        ))}
      </aside>
    </section>
  );
}
