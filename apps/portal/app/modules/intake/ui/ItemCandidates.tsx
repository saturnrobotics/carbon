import type { ItemCandidate, ItemSearchResult } from "@carbon/portal";
import { Trans, useLingui } from "@lingui/react/macro";
import { type KeyboardEvent, useId, useState } from "react";
import { type ItemAssociation, toItemAssociation } from "../intake.models";

function describe(item: {
  readableId: string;
  name: string;
  revision: string | null;
  mpn: string | null;
}) {
  return [
    item.readableId,
    item.name,
    item.revision ? `rev ${item.revision}` : null,
    item.mpn ? `MPN ${item.mpn}` : null
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The refusal class the gateway named, or unavailability when it named none.
 * The gateway sends the class alone, never the service's own code, so this can
 * only ever learn whether the reader was refused — not what was there.
 */
async function refusalOf(response: Response): Promise<string> {
  try {
    const code = ((await response.json()) as { error?: unknown } | null)?.error;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
      ? code
      : "items_unavailable";
  } catch {
    return "items_unavailable";
  }
}

/**
 * Existing-item candidates from the Carbon canonical read, through the query
 * gateway. The reviewer picks one item or none; a generic document is the
 * default. The choice travels with the review form as a hidden JSON field.
 */
export function ItemCandidates({
  value,
  decided,
  disabled,
  onChange
}: {
  value: ItemAssociation | null;
  decided: boolean;
  disabled?: boolean;
  onChange: (item: ItemAssociation | null) => void;
}) {
  const { t } = useLingui();
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<ItemSearchResult>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  function describeFailure(code: string) {
    // A refusal is not an outage, and telling a reviewer to come back later
    // when the answer will not change is the defect this names. Both wordings
    // are the portal's existing copy, and each says only that this reader may
    // not do this — never what exists.
    if (code === "forbidden")
      return t`You do not have permission for this action in this library.`;
    if (code === "unauthorized")
      return t`You are not signed in to this library, or your access was revoked.`;
    return t`Item lookup is unavailable right now.`;
  }

  async function lookup() {
    const term = search.trim();
    if (!term) return;
    setPending(true);
    setFailure(undefined);
    try {
      const response = await fetch("/api/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ search: term, limit: 10 })
      });
      if (!response.ok) {
        setResult(undefined);
        setFailure(describeFailure(await refusalOf(response)));
        return;
      }
      setResult((await response.json()) as ItemSearchResult);
    } catch {
      setResult(undefined);
      setFailure(describeFailure("items_unavailable"));
    } finally {
      setPending(false);
    }
  }

  function keydown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter searches; it must not submit the surrounding review form.
    if (event.key === "Enter") {
      event.preventDefault();
      void lookup();
    }
  }

  const candidates: ItemCandidate[] = result?.items ?? [];
  const selectedListed = candidates.some((item) => item.id === value?.id);

  return (
    <fieldset className="item-candidates" disabled={disabled}>
      <legend>
        <Trans>Existing item</Trans>
      </legend>
      <p>
        <Trans>
          Link this document to one existing item, or keep it as a generic
          document. Linking never creates or changes items.
        </Trans>
      </p>
      <div className="item-search" role="search">
        <label htmlFor={searchId}>
          <Trans>Search items</Trans>
        </label>
        <input
          id={searchId}
          maxLength={256}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={keydown}
          placeholder={t`Part number, MPN, or name`}
          type="search"
          value={search}
        />
        <button
          disabled={pending || !search.trim()}
          onClick={() => void lookup()}
          type="button"
        >
          {pending ? t`Searching…` : t`Search items`}
        </button>
      </div>
      {failure ? <p role="alert">{failure}</p> : null}
      {result?.status === "unavailable" ? (
        <p role="status">
          <Trans>
            Item lookup is not available for this library. The document can
            still be published as a generic document.
          </Trans>
        </p>
      ) : null}
      {result?.status === "partial" ? (
        <p role="status">
          <Trans>Only the first candidates are shown; narrow the search.</Trans>
        </p>
      ) : null}
      {result?.status === "complete" && candidates.length === 0 ? (
        <p role="status">
          <Trans>No matching items.</Trans>
        </p>
      ) : null}
      <div
        aria-label={t`Item association`}
        className="item-choices"
        role="radiogroup"
      >
        <label>
          <input
            checked={value === null}
            name="itemChoice"
            onChange={() => onChange(null)}
            type="radio"
            value=""
          />
          <Trans>No item association (generic document)</Trans>
        </label>
        {value && !selectedListed ? (
          <label>
            <input
              checked
              name="itemChoice"
              onChange={() => onChange(value)}
              type="radio"
              value={value.id}
            />
            {describe(value)}
          </label>
        ) : null}
        {candidates.map((candidate) => (
          <label key={candidate.id}>
            <input
              checked={value?.id === candidate.id}
              name="itemChoice"
              onChange={() => onChange(toItemAssociation(candidate))}
              type="radio"
              value={candidate.id}
            />
            {describe(candidate)}
          </label>
        ))}
      </div>
      {!decided ? (
        <p className="item-undecided">
          <Trans>Not yet decided. Saving the review records your choice.</Trans>
        </p>
      ) : null}
      <input name="item" type="hidden" value={JSON.stringify(value)} />
    </fieldset>
  );
}
