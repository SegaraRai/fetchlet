import { runtime } from "./runtime";

if (!runtime.setTimeout) {
  let nextId = 1;
  const timers = new Map<
    number,
    {
      due: number;
      callback: Function;
      args: any[];
    }
  >();
  runtime.setTimeout = (callback: Function, delay = 0, ...args: any[]): number => {
    if (typeof callback !== "function") {
      throw new TypeError("Expected callback");
    }
    const id = nextId++;
    timers.set(id, {
      due: Date.now() + Math.max(0, Number(delay) || 0),
      callback,
      args,
    });
    return id;
  };
  runtime.clearTimeout = (id: number): void => {
    timers.delete(id);
  };

  // Invocation completion owns timer cleanup in the buffered profile.
  runtime.__fetchletClearTimers = () => {
    timers.clear();
  };
  runtime.__fetchletTimerDelay = () => {
    let nextDue = Infinity;
    for (const timer of timers.values()) {
      nextDue = Math.min(nextDue, timer.due);
    }
    return Number.isFinite(nextDue) ? Math.max(0, nextDue - Date.now()) : -1;
  };
  runtime.__fetchletRunNextTimer = () => {
    const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
    if (next && next[1].due <= Date.now()) {
      timers.delete(next[0]);
      next[1].callback(...next[1].args);
      return true;
    }
    return false;
  };
}
