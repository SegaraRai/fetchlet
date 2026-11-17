import { createAsync } from "@solidjs/router";
import { Suspense } from "solid-js";

// The shell streams first; the slow value follows in the same response.
export default function Deferred() {
  const value = createAsync(
    () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("A value that arrived late"), 200)),
  );
  return (
    <main>
      <h1>Deferred data</h1>
      <Suspense fallback={<p data-pending>Loading…</p>}>
        <p data-resolved>{value()}</p>
      </Suspense>
    </main>
  );
}
