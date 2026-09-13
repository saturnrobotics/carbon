import { Trans } from "@lingui/react/macro";
import { useActionData, useLoaderData } from "react-router";
import {
  listDriveSources,
  requestDriveSourceSync
} from "../modules/sources/sources.service";
import { DriveSourceList } from "../modules/sources/ui/DriveSourceList";

export async function loader({ request }: { request: Request }) {
  const sources = await listDriveSources(request);
  return { sources };
}

/** Enrollment is an administrator action; the portal can only ask for a sync. */
export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  if (form.get("intent") !== "sync") return { requested: null };
  const sourceId = String(form.get("sourceId") ?? "");
  const requested = await requestDriveSourceSync(request, sourceId);
  return { requested: requested ? sourceId : null };
}

export function headers() {
  return { "cache-control": "private, no-store" };
}

export default function SourceSettingsRoute() {
  const { sources } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <main className="page-shell">
      <a className="back-link" href="/">
        <Trans>Back to manual search</Trans>
      </a>
      <p className="eyebrow">
        <Trans>Sources</Trans>
      </p>
      <h1>
        <Trans>Google Drive sources</Trans>
      </h1>
      <p>
        <Trans>
          Drive sources are enrolled by an administrator with a read-only
          connector credential held in Secret Manager. Signing into this portal
          does not authorize Drive access: a document is delivered only after a
          live check with your own Drive permissions.
        </Trans>
      </p>
      <DriveSourceList sources={sources} requested={result?.requested} />
    </main>
  );
}
