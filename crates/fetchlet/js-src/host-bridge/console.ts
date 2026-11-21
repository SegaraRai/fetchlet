import { dispatch } from "./host.ts";

function formatConsoleValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    const stack = typeof value.stack === "string" ? value.stack : "";
    const head = value.name + ": " + value.message;
    return stack.includes(value.message) ? stack : head + (stack ? "\n" + stack : "");
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

// The host's console sink receives one formatted message per call. Logging
// never throws into the application: a message the bridge refuses, such as
// one over the message budget, is replaced by a notice.
export function installConsole(): void {
  const write =
    (level: string) =>
    (...values: unknown[]) => {
      try {
        dispatch("console.write", {
          level,
          message: values.map(formatConsoleValue).join(" "),
        });
      } catch {
        try {
          dispatch("console.write", {
            level,
            message: "[fetchlet: console message dropped]",
          });
        } catch {
          // The sink is unavailable; output is discarded as without a sink.
        }
      }
    };
  globalThis.console = Object.assign(globalThis.console ?? {}, {
    debug: write("debug"),
    log: write("log"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  });
}
