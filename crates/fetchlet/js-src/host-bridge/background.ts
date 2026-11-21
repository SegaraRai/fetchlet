// Background work registered with fetchlet.waitUntil. The invocation stays
// open, with its timers and host scope, until every task settles; Rust
// bounds that with Limits::background_timeout. Rejections are absorbed: a
// task's outcome does not change the response.

import { dispatch } from "./host.ts";

const backgroundTasks = new Set<Promise<void>>();

export function waitUntil(promise: unknown): void {
  // Throws outside an invocation or over Limits::background_tasks.
  dispatch("background.register", null);
  const task = Promise.resolve(promise)
    .then(
      () => {},
      () => {},
    )
    .then(() => {
      backgroundTasks.delete(task);
      try {
        dispatch("background.settle", null);
      } catch {
        // The invocation ended; nothing waits for this task any more.
      }
    });
  backgroundTasks.add(task);
}

export const backgroundRegistry = Object.freeze<BackgroundRegistry>({
  pending() {
    return backgroundTasks.size;
  },
  // Resolve once every task, including ones registered meanwhile, settled.
  async settle() {
    while (backgroundTasks.size > 0) {
      await Promise.all(Array.from(backgroundTasks));
    }
  },
  // Forget tasks of an invocation that ended without settling them.
  clear() {
    backgroundTasks.clear();
  },
});
