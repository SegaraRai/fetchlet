// Workspace changes, pushed by Rust. A browser of `mdw serve` reads them as
// server-sent events; the desktop window receives them as Tauri events,
// because its URI scheme protocol answers with complete bodies.
import type { Change } from "#lib/api/types.gen.ts";

export type { Change };

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Calls `onChange` for every change until the returned function is called.
 * Changes before the subscription starts are not reported, so `onConnect`
 * runs each time it does, for a caller that must not miss one.
 */
export function subscribeToChanges(
  onChange: (change: Change) => void,
  onConnect?: () => void,
): () => void {
  if (isDesktop()) {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen<Change>("workspace-changed", (event) => onChange(event.payload));
      if (stopped) {
        stop();
      } else {
        unlisten = stop;
        onConnect?.();
      }
    });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }
  const source = new EventSource("/api/v1/events");
  source.addEventListener("change", (event) => onChange(JSON.parse(event.data) as Change));
  // The server subscribes before it answers, and EventSource reconnects on
  // its own, so each open covers the changes since the last.
  if (onConnect) {
    source.addEventListener("open", onConnect);
  }
  return () => source.close();
}
