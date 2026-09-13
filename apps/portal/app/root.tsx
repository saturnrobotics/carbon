import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import type { LinksFunction } from "react-router";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useRouteLoaderData
} from "react-router";
import stylesheet from "./app.css?url";
import { loadLinguiCatalog } from "./services/lingui.server";
import {
  LocaleProvider,
  languageFromRequest,
  type SupportedLanguage
} from "./services/locale";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet }
];

export async function loader({ request }: { request: Request }) {
  const language = languageFromRequest(request);
  return { language, catalog: await loadLinguiCatalog(language) };
}

type RootData = {
  language: SupportedLanguage;
  catalog: Record<string, string>;
};

export function Layout({ children }: { children: ReactNode }) {
  const data = useRouteLoaderData("root") as RootData | undefined;
  return (
    <html lang={data?.language ?? "en"}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <LocaleProvider
          language={data?.language ?? "en"}
          catalog={data?.catalog}
        >
          {children}
        </LocaleProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  useLoaderData<typeof loader>();
  return <Outlet />;
}

/** Route loaders and actions throw short codes; the copy lives here so every
 * failure page is translated and no worker detail reaches the browser. */
function useErrorCopy() {
  const { t } = useLingui();
  const copy: Record<string, string> = {
    unauthorized: t`You are not signed in to this library, or your access was revoked.`,
    forbidden: t`You do not have permission for this action in this library.`,
    version_conflict: t`This document changed while you were working. Reload it and try again.`,
    invalid_request: t`The request was not valid.`,
    acquisition_failed: t`The document could not be fetched from that address.`,
    intake_not_found: t`This document is not available for review.`,
    document_not_found: t`This document version is not available.`,
    document_access_revoked: t`Access to this document was revoked.`,
    not_found: t`Page not found.`,
    company_required: t`The company is not configured for Portal.`,
    capture_failed: t`The upload could not be captured.`,
    review_invalid: t`Valid review fields are required.`,
    not_configured: t`This action is not configured for the library.`,
    service_unavailable: t`Portal could not complete this request.`
  };
  return (code: unknown) =>
    (typeof code === "string" && copy[code]) || copy.service_unavailable;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const { t } = useLingui();
  const describe = useErrorCopy();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const code = isRouteErrorResponse(error)
    ? typeof error.data === "object" && error.data !== null
      ? (error.data as { error?: unknown }).error
      : error.data
    : undefined;
  return (
    <main style={{ margin: "4rem auto", maxWidth: 720, padding: "0 1.5rem" }}>
      <h1>{t`Request unavailable`}</h1>
      <p>{describe(code)}</p>
      <p>{t`Status ${status}`}</p>
    </main>
  );
}
