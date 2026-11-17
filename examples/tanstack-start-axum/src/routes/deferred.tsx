import { Await, createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";

// The shell streams first; the slow value follows in the same response.
export const Route = createFileRoute("/deferred")({
  loader: () => ({
    slow: new Promise<string>((resolve) =>
      setTimeout(() => resolve("A value that arrived late"), 200),
    ),
  }),
  component: Deferred,
});

function Deferred() {
  const { slow } = Route.useLoaderData();
  return (
    <main>
      <h1>Deferred data</h1>
      <Suspense fallback={<p data-pending>Loading…</p>}>
        <Await promise={slow}>{(value) => <p data-resolved>{value}</p>}</Await>
      </Suspense>
    </main>
  );
}
