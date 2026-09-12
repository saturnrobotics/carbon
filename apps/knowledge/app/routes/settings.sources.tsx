import { Trans } from "@lingui/react/macro";

export default function SourceSettingsRoute() {
  return (
    <main>
      <h1>
        <Trans>Sources</Trans>
      </h1>
      <p>
        <Trans>
          Drive sources are enrolled by an administrator. Portal sign-in does
          not authorize Drive access.
        </Trans>
      </p>
    </main>
  );
}
