import { runtime } from "./runtime";

function isByteStream(stream: any): boolean {
  try {
    stream.getReader({ mode: "byob" }).releaseLock();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch "tee" for body streams: the second branch receives a structured clone of each chunk.
 *
 * Byte streams use the provider's byte tee, which already copies chunks. Default streams follow
 * ReadableStreamDefaultTee with cloneForBranch2 = true, which the public tee() does not expose.
 */
export function teeBody(stream: any): [any, any] {
  if (isByteStream(stream)) {
    return stream.tee();
  }

  const reader = stream.getReader();
  let reading = false;
  let readAgain = false;
  let canceled1 = false;
  let canceled2 = false;
  let reason1: unknown;
  let reason2: unknown;
  let controller1: any;
  let controller2: any;
  let resolveCancel!: (value: unknown) => void;
  const cancelled = new Promise((resolve) => {
    resolveCancel = resolve;
  });

  function settle(error?: unknown) {
    if (error !== undefined) {
      controller1.error(error);
      controller2.error(error);
    }
    if (!canceled1 || !canceled2) {
      resolveCancel(undefined);
    }
  }

  function pull(): Promise<void> {
    if (reading) {
      readAgain = true;
      return Promise.resolve();
    }
    reading = true;
    reader.read().then(
      (result: any) => {
        reading = false;
        if (result.done) {
          if (!canceled1) {
            controller1.close();
          }
          if (!canceled2) {
            controller2.close();
          }
          settle();
          return;
        }
        const chunk = result.value;
        let clone = chunk;
        if (!canceled2) {
          try {
            clone = runtime.structuredClone(chunk);
          } catch (error) {
            controller1.error(error);
            controller2.error(error);
            resolveCancel(reader.cancel(error));
            return;
          }
        }
        if (!canceled1) {
          controller1.enqueue(chunk);
        }
        if (!canceled2) {
          controller2.enqueue(clone);
        }
        if (readAgain) {
          readAgain = false;
          void pull();
        }
      },
      (error: unknown) => {
        reading = false;
        settle(error);
      },
    );
    return Promise.resolve();
  }

  const branch1 = new runtime.ReadableStream({
    start(controller: any) {
      controller1 = controller;
    },
    pull,
    cancel(reason: unknown) {
      canceled1 = true;
      reason1 = reason;
      if (canceled2) {
        resolveCancel(reader.cancel([reason1, reason2]));
      }
      return cancelled;
    },
  });
  const branch2 = new runtime.ReadableStream({
    start(controller: any) {
      controller2 = controller;
    },
    pull,
    cancel(reason: unknown) {
      canceled2 = true;
      reason2 = reason;
      if (canceled1) {
        resolveCancel(reader.cancel([reason1, reason2]));
      }
      return cancelled;
    },
  });
  reader.closed.catch((error: unknown) => settle(error));
  return [branch1, branch2];
}
