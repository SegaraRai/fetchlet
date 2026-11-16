import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: () => (
    <main>
      <h1>このページについて</h1>
      <p>TanStack StartのSSRとhydrationを、axumの中のfetchletで実行しています。</p>
    </main>
  ),
});
