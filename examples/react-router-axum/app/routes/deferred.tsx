import { Suspense } from "react";
import { Await } from "react-router";
import type { Route } from "./+types/deferred";

// The shell renders first; the slow value streams in the same response.
export function loader() {
  return {
    slow: new Promise<string>((resolve) => setTimeout(() => resolve("遅れて届いた値"), 200)),
  };
}

export default function Deferred({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>遅延データ</h1>
      <Suspense fallback={<p data-pending>読み込み中…</p>}>
        <Await resolve={loaderData.slow}>{(value) => <p data-resolved>{value}</p>}</Await>
      </Suspense>
    </main>
  );
}
