import { confidenceBucket } from "@carbon/knowledge/intake/confidence";
import type { ProposedField } from "@carbon/knowledge/intake/contracts";
import { useMemo, useState } from "react";
import type { IntakeReviewModel } from "../intake.models";
import {
  additionalProposals,
  displayField,
  formatProposal,
  proposalFor,
  reviewFields,
  unresolvedNamesFor
} from "../intake.models";

const percent = new Intl.NumberFormat(undefined, { style: "percent" });

function ProposalNote({ proposal }: { proposal: ProposedField }) {
  const pages = [...new Set(proposal.evidence.map((entry) => entry.page))];
  return (
    <small>
      Proposed {formatProposal(proposal)} (
      {confidenceBucket(proposal.confidence)},{" "}
      {percent.format(proposal.confidence)} confidence)
      {pages.length > 0
        ? ` from page ${pages.join(", ")}`
        : " without page evidence"}
    </small>
  );
}

function Acknowledge({
  id,
  names,
  acknowledged,
  onToggle
}: {
  id: string;
  names: readonly string[];
  acknowledged: readonly string[];
  onToggle: (names: readonly string[], checked: boolean) => void;
}) {
  return (
    <small id={id}>
      Confirm this field against the source evidence.{" "}
      <label>
        <input
          type="checkbox"
          checked={names.every((name) => acknowledged.includes(name))}
          onChange={(event) => onToggle(names, event.target.checked)}
        />
        I reviewed this evidence
      </label>
    </small>
  );
}

export function IntakeReview({ model }: { model: IntakeReviewModel }) {
  const initial = useMemo(
    () =>
      Object.fromEntries(
        reviewFields.map(([field]) => [field, displayField(model, field)])
      ),
    [model]
  );
  const [values, setValues] = useState(initial);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const unresolved = model.unresolved.filter(
    (name) => !acknowledged.includes(name)
  );
  const pendingFor = (names: readonly string[]) =>
    names.filter((name) => model.unresolved.includes(name));
  const toggle = (names: readonly string[], checked: boolean) =>
    setAcknowledged((current) =>
      checked
        ? [...new Set([...current, ...names])]
        : current.filter((name) => !names.includes(name))
    );
  const extras = additionalProposals(model);
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
        {reviewFields.map(([field, label]) => {
          const proposal = proposalFor(model, field);
          const pending = pendingFor(unresolvedNamesFor(field));
          return (
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
                  pending.length > 0 ? `${field}-unresolved` : undefined
                }
              />
              {proposal && <ProposalNote proposal={proposal} />}
              {pending.length > 0 && (
                <Acknowledge
                  id={`${field}-unresolved`}
                  names={pending}
                  acknowledged={acknowledged}
                  onToggle={toggle}
                />
              )}
            </label>
          );
        })}
        {extras.length > 0 && (
          <fieldset aria-label="Additional proposed fields">
            <legend>Also proposed</legend>
            {extras.map(({ name, label, proposal }) => {
              const pending = pendingFor([name]);
              return (
                <p key={name}>
                  {label}: <ProposalNote proposal={proposal} />
                  {pending.length > 0 && (
                    <Acknowledge
                      id={`${name}-unresolved`}
                      names={pending}
                      acknowledged={acknowledged}
                      onToggle={toggle}
                    />
                  )}
                </p>
              );
            })}
          </fieldset>
        )}
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
