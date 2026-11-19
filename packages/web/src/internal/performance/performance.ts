// High Resolution Time's Performance interface and User Timing marks and
// measures (https://w3c.github.io/hr-time/, https://w3c.github.io/user-timing/).
// The clock is the host's monotonic clock. Entries belong to the invocation
// that records them: the end of each invocation clears them, so an instance
// that serves many requests does not accumulate them.

import { EventTargetImpl } from "../dom/events";
import { hostFunctions } from "../runtime/host";
import { runtime } from "../runtime/runtime";
import { dictionary, domString, exposeAttributes } from "../webidl/idl";

const CREATE = Symbol("create");

function readClock(): {
  timeOrigin: number;
  now: number;
} {
  const reply = JSON.parse(hostFunctions()!.call("clock", "null"));
  if (!reply.ok) {
    throw new Error(reply.error.message);
  }
  return reply.value;
}

interface EntryState {
  name: string;
  entryType: "mark" | "measure";
  startTime: number;
  duration: number;
  detail: unknown;
}

const entries = new WeakMap<object, EntryState>();

function entry(value: unknown): EntryState {
  const found = entries.get(value as object);
  if (!found) {
    throw new TypeError("Illegal invocation");
  }
  return found;
}

class PerformanceEntryImpl {
  constructor(token?: symbol, state?: EntryState) {
    if (token !== CREATE || !state) {
      throw new TypeError("Illegal constructor");
    }
    entries.set(this, state);
  }

  get name() {
    return entry(this).name;
  }

  get entryType() {
    return entry(this).entryType;
  }

  get startTime() {
    return entry(this).startTime;
  }

  get duration() {
    return entry(this).duration;
  }

  toJSON() {
    const { name, entryType, startTime, duration } = entry(this);
    return { name, entryType, startTime, duration };
  }

  get [Symbol.toStringTag]() {
    return "PerformanceEntry";
  }
}

function cloneDetail(detail: unknown): unknown {
  return detail === undefined || detail === null ? null : runtime.structuredClone(detail);
}

function timestamp(value: unknown, name: string): number {
  const number = +(value as number);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if (number < 0) {
    throw new TypeError(`${name} must not be negative`);
  }
  return number;
}

class PerformanceMarkImpl extends PerformanceEntryImpl {
  constructor(
    markName: string,
    markOptions?: {
      detail?: unknown;
      startTime?: number;
    },
  ) {
    if (arguments.length < 1) {
      throw new TypeError("PerformanceMark requires a name");
    }
    const name = domString(markName);
    const options = dictionary(markOptions);
    const startTime =
      options.startTime === undefined
        ? performanceNow()
        : timestamp(options.startTime, "startTime");
    super(CREATE, {
      name,
      entryType: "mark",
      startTime,
      duration: 0,
      detail: cloneDetail(options.detail),
    });
  }

  get detail() {
    return entry(this).detail;
  }

  toJSON() {
    return { ...super.toJSON(), detail: entry(this).detail };
  }

  get [Symbol.toStringTag]() {
    return "PerformanceMark";
  }
}

class PerformanceMeasureImpl extends PerformanceEntryImpl {
  constructor(token?: symbol, state?: EntryState) {
    super(token, state);
  }

  get detail() {
    return entry(this).detail;
  }

  toJSON() {
    return { ...super.toJSON(), detail: entry(this).detail };
  }

  get [Symbol.toStringTag]() {
    return "PerformanceMeasure";
  }
}

let timeOrigin = 0;
let clock: (() => number) | undefined;

function performanceNow(): number {
  if (!clock) {
    throw new TypeError("The performance clock is not available");
  }
  return clock();
}

/** Marks and measures of the current invocation, in recording order. */
const timeline: PerformanceEntryImpl[] = [];

function sorted(list: PerformanceEntryImpl[]): PerformanceEntryImpl[] {
  // Array.prototype.sort is stable, so equal start times keep recording order.
  return list.slice().sort((a, b) => entry(a).startTime - entry(b).startTime);
}

function clear(type: "mark" | "measure", name: unknown) {
  const filter = name === undefined ? undefined : domString(name);
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const state = entry(timeline[index]);
    if (state.entryType === type && (filter === undefined || state.name === filter)) {
      timeline.splice(index, 1);
    }
  }
}

/** User Timing "convert a mark to a timestamp". */
function markTimestamp(mark: unknown): number {
  if (typeof mark === "string") {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const state = entry(timeline[index]);
      if (state.entryType === "mark" && state.name === mark) {
        return state.startTime;
      }
    }
    throw new runtime.DOMException(`No mark named "${mark}"`, "SyntaxError");
  }
  return timestamp(mark, "A mark timestamp");
}

function markName(value: unknown): unknown {
  return typeof value === "number" ? value : domString(value);
}

class PerformanceImpl extends EventTargetImpl {
  constructor(token?: symbol) {
    if (token !== CREATE) {
      throw new TypeError("Illegal constructor");
    }
    super();
  }

  now() {
    return performanceNow();
  }

  get timeOrigin() {
    return timeOrigin;
  }

  toJSON() {
    return { timeOrigin };
  }

  mark(markName: string, markOptions?: { detail?: unknown; startTime?: number }) {
    if (arguments.length < 1) {
      throw new TypeError("mark requires a name");
    }
    const mark = new PerformanceMarkImpl(markName, markOptions);
    timeline.push(mark);
    return mark;
  }

  clearMarks(name?: string) {
    clear("mark", name);
  }

  measure(
    measureName: string,
    startOrMeasureOptions?:
      | string
      | {
          start?: string | number;
          end?: string | number;
          duration?: number;
          detail?: unknown;
        },
    endMark?: string,
  ) {
    if (arguments.length < 1) {
      throw new TypeError("measure requires a name");
    }
    const name = domString(measureName);
    const options =
      startOrMeasureOptions !== null &&
      typeof startOrMeasureOptions === "object" &&
      !Array.isArray(startOrMeasureOptions)
        ? startOrMeasureOptions
        : undefined;
    const start = options ? options.start : startOrMeasureOptions;
    const end = options ? options.end : endMark;
    const duration = options?.duration;
    if (
      options &&
      [options.start, options.end, duration, options.detail].some((value) => value !== undefined)
    ) {
      if (endMark !== undefined) {
        throw new TypeError("measure takes an end mark or options, not both");
      }
      if (start === undefined && end === undefined) {
        throw new TypeError("measure options need a start or an end");
      }
      if (start !== undefined && end !== undefined && duration !== undefined) {
        throw new TypeError("measure options take at most two of start, end and duration");
      }
    }
    let endTime: number;
    if (end !== undefined) {
      endTime = markTimestamp(markName(end));
    } else if (start !== undefined && duration !== undefined) {
      endTime = markTimestamp(markName(start)) + timestamp(duration, "duration");
    } else {
      endTime = performanceNow();
    }
    let startTime: number;
    if (start !== undefined) {
      startTime = markTimestamp(markName(start));
    } else if (duration !== undefined && end !== undefined) {
      startTime = endTime - timestamp(duration, "duration");
    } else {
      startTime = 0;
    }
    const measure = new PerformanceMeasureImpl(CREATE, {
      name,
      entryType: "measure",
      startTime,
      duration: endTime - startTime,
      detail: cloneDetail(options?.detail),
    });
    timeline.push(measure);
    return measure;
  }

  clearMeasures(name?: string) {
    clear("measure", name);
  }

  getEntries() {
    return sorted(timeline);
  }

  getEntriesByType(type: string) {
    const wanted = domString(type);
    return sorted(timeline.filter((item) => entry(item).entryType === wanted));
  }

  getEntriesByName(name: string, type?: string) {
    const wanted = domString(name);
    const wantedType = type === undefined ? undefined : domString(type);
    return sorted(
      timeline.filter((item) => {
        const state = entry(item);
        return (
          state.name === wanted && (wantedType === undefined || state.entryType === wantedType)
        );
      }),
    );
  }

  get [Symbol.toStringTag]() {
    return "Performance";
  }
}

exposeAttributes(PerformanceEntryImpl.prototype, ["name", "entryType", "startTime", "duration"]);
exposeAttributes(PerformanceMarkImpl.prototype, ["detail"]);
exposeAttributes(PerformanceMeasureImpl.prototype, ["detail"]);
exposeAttributes(PerformanceImpl.prototype, ["timeOrigin"]);

for (const [constructor, name] of [
  [PerformanceEntryImpl, "PerformanceEntry"],
  [PerformanceMarkImpl, "PerformanceMark"],
  [PerformanceMeasureImpl, "PerformanceMeasure"],
  [PerformanceImpl, "Performance"],
] as const) {
  Object.defineProperty(constructor, "name", {
    value: name,
  });
}

// QuickJS has a performance object with `now` only; this profile replaces
// any performance object without User Timing.
if (typeof runtime.performance?.mark !== "function" && hostFunctions() !== null) {
  timeOrigin = readClock().timeOrigin;
  clock = () => readClock().now;
  runtime.Performance = PerformanceImpl;
  runtime.PerformanceEntry = PerformanceEntryImpl;
  runtime.PerformanceMark = PerformanceMarkImpl;
  runtime.PerformanceMeasure = PerformanceMeasureImpl;
  runtime.performance = new PerformanceImpl(CREATE);
  Object.defineProperty(runtime, "__fetchletClearPerformanceEntries", {
    value: () => {
      timeline.length = 0;
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

export { PerformanceEntryImpl, PerformanceImpl, PerformanceMarkImpl, PerformanceMeasureImpl };
