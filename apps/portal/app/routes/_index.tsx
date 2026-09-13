import { readManualSourceConfiguration } from "@carbon/portal/release-profile";
import { Trans } from "@lingui/react/macro";
import { useLoaderData } from "react-router";
import { QueryInput } from "../modules/portal/ui/QueryInput";

export function loader() {
  const source = readManualSourceConfiguration(process.env);
  return {
    sourceDisplayName: source.displayName,
    // The company this deployment serves; a change resets client-held results.
    scope: process.env.PORTAL_COMPANY_ID ?? ""
  };
}

/** Private results must never survive in a shared cache or the back-forward cache. */
export function headers() {
  return { "cache-control": "private, no-store" };
}

export default function PortalHome() {
  const { sourceDisplayName, scope } = useLoaderData<typeof loader>();
  return (
    <main className="page-shell">
      <header>
        <p className="eyebrow">
          <Trans>Portal</Trans>
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
        <a className="signout-link" href="/logout">
          Sign out
        </a>
      </header>
      <QueryInput key={scope} sourceDisplayName={sourceDisplayName} />
    </main>
  );
}
