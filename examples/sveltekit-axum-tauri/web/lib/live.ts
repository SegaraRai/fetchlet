// Workspace changes, pushed by Rust. A browser of `mdw serve` reads them as
// server-sent events; the desktop window receives them as Tauri events,
// because its URI scheme protocol answers with complete bodies.
import type { Change } from "#lib/api/types.gen.ts";

export type { Change };

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Calls `onChange` for every change until the returned function is called. */
export function subscribeToChanges(onChange: (change: Change) => void): () => void {
  if (isDesktop()) {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen<Change>("workspace-changed", (event) => onChange(event.payload));
      if (stopped) stop();
      else unlisten = stop;
    });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }
  const source = new EventSource("/api/v1/events");
  source.addEventListener("change", (event) => onChange(JSON.parse(event.data) as Change));
  return () => source.close();
}
