import { runtime } from "./runtime";

if (!runtime.performance && typeof runtime.__fetchletHost === "function") {
  function readClock(): {
    timeOrigin: number;
    now: number;
  } {
    const reply = JSON.parse(runtime.__fetchletHost("clock", "null"));
    if (!reply.ok) {
      throw new Error(reply.error.message);
    }
    return reply.value;
  }

  const origin = readClock().timeOrigin;
  runtime.performance = {
    timeOrigin: origin,
    now: () => readClock().now,
    toJSON: () => ({
      timeOrigin: origin,
    }),
  };
}
