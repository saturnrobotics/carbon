import { readManualSourceConfiguration } from "@carbon/knowledge/release-profile";
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
        <p className="eyebrow">Company knowledge</p>
        <h1>Find the right manual.</h1>
        <p>
          Search published company manuals by manufacturer, part number,
          revision, machine, or keyword. Open the exact original version from
          every result.
        </p>
      </header>
      <QueryInput sourceDisplayName={sourceDisplayName} />
    </main>
  );
}
