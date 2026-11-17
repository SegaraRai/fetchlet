import { runtime } from "./runtime";

if (!runtime.setTimeout) {
  let nextId = 1;
  // Timeouts and intervals share one list of identifiers, as in HTML, so
  // either clear function cancels either kind.
  const timers = new Map<
    number,
    {
      due: number;
      callback: Function;
      args: any[];
      /** The repeat delay of an interval; undefined for a timeout. */
      repeat?: number;
    }
  >();
  function schedule(callback: Function, delay: unknown, args: any[], repeat: boolean): number {
    if (typeof callback !== "function") {
      throw new TypeError("Expected callback");
    }
    const id = nextId++;
    const milliseconds = Math.max(0, Number(delay) || 0);
    timers.set(id, {
      due: Date.now() + milliseconds,
      callback,
      args,
      repeat: repeat ? milliseconds : undefined,
    });
    return id;
  }
  function clear(id: number): void {
    timers.delete(id);
  }
  runtime.setTimeout = (callback: Function, delay = 0, ...args: any[]): number =>
    schedule(callback, delay, args, false);
  runtime.setInterval = (callback: Function, delay = 0, ...args: any[]): number =>
    schedule(callback, delay, args, true);
  runtime.clearTimeout = clear;
  runtime.clearInterval = clear;

  // Invocation completion owns timer cleanup in the buffered profile, which
  // also ends intervals that are still running.
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
      const [id, timer] = next;
      timers.delete(id);
      if (timer.repeat !== undefined) {
        // Rescheduled before the callback runs, so the callback can clear it.
        timers.set(id, { ...timer, due: Date.now() + timer.repeat });
      }
      timer.callback(...timer.args);
      return true;
    }
    return false;
  };
}
