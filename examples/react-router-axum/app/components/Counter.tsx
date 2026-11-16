import { useEffect, useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <button
      type="button"
      data-counter
      data-hydrated={String(hydrated)}
      onClick={() => setCount(count + 1)}
    >
      クリック {count}
    </button>
  );
}
