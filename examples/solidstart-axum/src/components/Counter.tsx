import { createSignal, onMount } from "solid-js";

export function Counter() {
  const [count, setCount] = createSignal(0);
  const [hydrated, setHydrated] = createSignal(false);
  onMount(() => setHydrated(true));
  return (
    <button
      type="button"
      data-counter
      data-hydrated={String(hydrated())}
      onClick={() => setCount(count() + 1)}
    >
      {`クリック ${count()}`}
    </button>
  );
}
