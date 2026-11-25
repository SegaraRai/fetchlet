import { Suspense } from "react";

// The shell streams first; the slow server component follows in the same response.
// The delay outlasts the shell's rendering on a debug build of Boa, which takes
// up to 1.4 s, so the streaming check holds on every engine.
async function Slow() {
  const value = await new Promise<string>((resolve) =>
    setTimeout(() => resolve("A value that arrived late"), 3000),
  );
  return <p data-resolved>{value}</p>;
}

export default function Deferred() {
  return (
    <main>
      <h1>Deferred data</h1>
      <Suspense fallback={<p data-pending>Loading…</p>}>
        <Slow />
      </Suspense>
    </main>
  );
}

export const getConfig = async () => ({ render: "dynamic" }) as const;
