import { data, useLoaderData } from "react-router";
import { carbonLoginUrl } from "../services/step-up.server";

/**
 * Shown when a Carbon source answered a request with the step-up denial: the
 * company requires two-factor authentication and the delegated path cannot
 * prove one. The portal has no step-up flow of its own by design.
 */
export function loader() {
  return data({ loginUrl: carbonLoginUrl(process.env) }, { status: 403 });
}

export default function StepUpRoute() {
  const { loginUrl } = useLoaderData<typeof loader>();
  return (
    <main className="page-shell">
      <a className="back-link" href="/">
        Back to manual search
      </a>
      <p className="eyebrow">Portal</p>
      <h1>Sign in to Carbon with two-factor authentication.</h1>
      <p>
        Your company requires two-factor authentication for this information,
        and this portal cannot confirm a Carbon two-factor sign-in on your
        behalf. Sign in to Carbon directly, complete its two-factor prompt, and
        open the record there.
      </p>
      {loginUrl ? (
        <a className="upload-link" href={loginUrl}>
          Sign in to Carbon
        </a>
      ) : null}
    </main>
  );
}
