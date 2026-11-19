import { createSignal, onSettled } from "solid-js";

export function Counter() {
  const [count, setCount] = createSignal(0);
  const [hydrated, setHydrated] = createSignal(false);
  onSettled(() => {
    setHydrated(true);
  });
  return (
    <button
      type="button"
      data-counter
      data-hydrated={String(hydrated())}
      onClick={() => setCount(count() + 1)}
    >
      {`Clicks ${count()}`}
    </button>
  );
}
