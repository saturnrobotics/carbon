import { data, useLoaderData } from "react-router";

export function loader() {
  return data({ error: "Page not found." }, { status: 404 });
}

export const action = loader;

export default function UnavailableRoute() {
  const { error } = useLoaderData<typeof loader>();

  return (
    <main style={{ margin: "4rem auto", maxWidth: 720, padding: "0 1.5rem" }}>
      <h1>Company knowledge</h1>
      <p>{error}</p>
    </main>
  );
}
