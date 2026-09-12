import { readManualSourceConfiguration } from "@carbon/knowledge/release-profile";
import { Trans } from "@lingui/react/macro";
import { useLoaderData } from "react-router";
import { QueryInput } from "../modules/portal/ui/QueryInput";

export function loader() {
  const source = readManualSourceConfiguration(process.env);
  return { sourceDisplayName: source.displayName };
}

export default function KnowledgeHome() {
  const { sourceDisplayName } = useLoaderData<typeof loader>();
  return (
    <main className="page-shell">
      <header>
        <p className="eyebrow">
          <Trans>Company knowledge</Trans>
        </p>
        <h1>
          <Trans>Find the right manual.</Trans>
        </h1>
        <p>
          <Trans>
            Search published company manuals by manufacturer, part number,
            revision, machine, or keyword. Open the exact original version from
            every result.
          </Trans>
        </p>
      </header>
      <QueryInput sourceDisplayName={sourceDisplayName} />
    </main>
  );
}
