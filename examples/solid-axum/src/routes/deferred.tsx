import { createMemo, Loading } from "solid-js";

// The shell streams first; the slow value follows in the same response.
export default function Deferred() {
  const value = createMemo(
    () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("A value that arrived late"), 200)),
  );
  return (
    <main>
      <h1>Deferred data</h1>
      <Loading fallback={<p data-pending>Loading…</p>}>
        <p data-resolved>{value()}</p>
      </Loading>
    </main>
  );
}
