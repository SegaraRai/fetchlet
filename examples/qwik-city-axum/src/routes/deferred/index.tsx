import { component$, Resource, useResource$ } from "@builder.io/qwik";

// Qwik waits for resources during SSR and streams in order: the content
// before the resource is sent while it resolves.
export default component$(() => {
  const slow = useResource$(
    () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("A value that arrived late"), 200)),
  );
  return (
    <main>
      <h1>Deferred data</h1>
      <p data-pending>Loading…</p>
      <Resource value={slow} onResolved={(value) => <p data-resolved>{value}</p>} />
    </main>
  );
});
