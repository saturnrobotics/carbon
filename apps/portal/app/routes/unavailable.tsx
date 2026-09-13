import { Trans } from "@lingui/react/macro";
import { data } from "react-router";

export function loader() {
  return data({ error: "not_found" }, { status: 404 });
}

export const action = loader;

export default function UnavailableRoute() {
  return (
    <main style={{ margin: "4rem auto", maxWidth: 720, padding: "0 1.5rem" }}>
      <h1>
        <Trans>Portal</Trans>
      </h1>
      <p>
        <Trans>Page not found.</Trans>
      </p>
    </main>
  );
}
