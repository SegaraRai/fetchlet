// The host step of the event loop (event-loop.ts): deliver what the host
// finished since the last step.

import { completeChannel, hasOpenChannels } from "./channels.ts";
import { completeFetch, hasPendingFetches } from "./fetch.ts";
import { completeCall, hasPendingCalls } from "./functions.ts";
import { completeRead, hasPendingReads } from "./host-bodies.ts";
import { dispatch } from "./host.ts";
import { abortIfDisconnected } from "./invocation.ts";
import type { Completion } from "./wire.ts";

/** Returns how many host events it delivered. */
export function pumpHostOperations(): number {
  const progress = abortIfDisconnected() ? 1 : 0;
  if (!hasPendingFetches() && !hasPendingReads() && !hasPendingCalls() && !hasOpenChannels()) {
    return progress;
  }

  const completions = dispatch<Completion[]>("fetch.poll", null);
  for (const completion of completions) {
    if (completeChannel(completion)) {
      continue;
    }
    if (!completeRead(completion) && !completeCall(completion)) {
      completeFetch(completion);
    }
  }

  return completions.length + progress;
}
