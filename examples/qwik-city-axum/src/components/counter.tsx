import { component$, useSignal, useVisibleTask$ } from "@builder.io/qwik";

export const Counter = component$(() => {
  const count = useSignal(0);
  // Qwik resumes instead of hydrating; this task runs once the button is visible.
  const hydrated = useSignal(false);
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(() => {
    hydrated.value = true;
  });
  return (
    <button
      type="button"
      data-counter
      data-hydrated={String(hydrated.value)}
      onClick$={() => count.value++}
    >
      {`Clicks ${count.value}`}
    </button>
  );
});
