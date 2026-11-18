// The async context of each host task source, read through the engine's
// slot with a minimal AsyncContext.Variable. The Node reference gives the
// expected values; an engine without a slot returns null.

interface Slot {
  get(): unknown;
  set(mapping: unknown): void;
}

const slot = (globalThis as { __fetchletAsyncContext?: Slot }).__fetchletAsyncContext;

class Variable {
  get(): unknown {
    const mapping = slot!.get();
    return mapping instanceof Map ? mapping.get(this) : undefined;
  }

  run<Result>(value: unknown, callback: () => Result): Result {
    const previous = slot!.get();
    const next = new Map(previous instanceof Map ? previous : []);
    next.set(this, value);
    slot!.set(next);
    try {
      return callback();
    } finally {
      slot!.set(previous);
    }
  }
}

const settle = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function asyncContextSources(): Promise<Record<string, unknown> | null> {
  if (!slot) {
    return null;
  }
  const variable = new Variable();
  const seen: Record<string, unknown> = {};
  const record = (name: string) => () => {
    seen[name] = variable.get() ?? null;
  };

  variable.run("timeout", () => setTimeout(record("setTimeout"), 0));
  let repeats = 0;
  const interval = variable.run("interval", () =>
    setInterval(() => {
      repeats += 1;
      record(`setInterval ${repeats}`)();
      if (repeats === 2) {
        clearInterval(interval);
      }
    }, 0),
  );
  variable.run("microtask", () => queueMicrotask(record("queueMicrotask")));

  const signal = variable.run("timeout call", () => AbortSignal.timeout(0));
  variable.run("listener", () => signal.addEventListener("abort", record("AbortSignal.timeout")));

  const target = new EventTarget();
  variable.run("listener", () => target.addEventListener("ping", record("dispatchEvent")));
  variable.run("dispatch", () => target.dispatchEvent(new Event("ping")));

  const channel = variable.run("created", () => new MessageChannel());
  variable.run("listener", () => {
    channel.port2.onmessage = record("MessagePort");
  });
  variable.run("posted", () => channel.port1.postMessage(null));

  const onRejection = (event: PromiseRejectionEvent) => {
    if (event.reason === "fixture rejection") {
      event.preventDefault();
      record("unhandledrejection")();
    }
  };
  const global = globalThis as unknown as EventTarget;
  global.addEventListener("unhandledrejection", onRejection as EventListener);
  variable.run("rejected", () => {
    void Promise.reject("fixture rejection");
  });

  await settle(20);
  channel.port1.close();
  global.removeEventListener("unhandledrejection", onRejection as EventListener);
  return seen;
}
