import { component$ } from "@builder.io/qwik";
import { useDocumentHead } from "@builder.io/qwik-city";

export const RouterHead = component$(() => {
  const head = useDocumentHead();
  return <title>{head.title || "Qwik City + axum"}</title>;
});
