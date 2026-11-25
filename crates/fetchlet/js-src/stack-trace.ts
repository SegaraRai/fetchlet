// Completes V8's stack trace API on QuickJS and Boa. Libraries written for
// Node.js call Error.captureStackTrace to give an object a stack or to hide
// their own frames, and some, such as depd, read call sites through
// Error.prepareStackTrace while they load.
//
// QuickJS provides the API with call sites that lack some of V8's methods;
// this adds them. Boa lacks the API, so Rust installs __fetchletStackFrames,
// which reads Boa's call stack, and this defines Error.captureStackTrace on
// it. Call sites report no receiver, type, method or constructor call, and
// every frame counts as top level.

type Frame = [
  functionName: string | null,
  fileName: string | null,
  line: number | null,
  column: number | null,
  isEval: boolean,
];

const defineProperty = Object.defineProperty;

/** The V8 call site methods both engines leave out or Boa needs. */
const callSiteDefaults = {
  getThis(): undefined {
    return undefined;
  },
  getTypeName(): null {
    return null;
  },
  getFunction(): undefined {
    return undefined;
  },
  getMethodName(): null {
    return null;
  },
  getEvalOrigin(): undefined {
    return undefined;
  },
  isToplevel(): boolean {
    return true;
  },
  isEval(): boolean {
    return false;
  },
  isNative(): boolean {
    return false;
  },
  isConstructor(): boolean {
    return false;
  },
  isAsync(): boolean {
    return false;
  },
  isPromiseAll(): boolean {
    return false;
  },
  getPromiseIndex(): null {
    return null;
  },
  getScriptNameOrSourceURL(this: CallSite): string | undefined {
    return this.getFileName();
  },
  toString(this: CallSite): string {
    let location = this.getFileName() ?? "<anonymous>";
    const line = this.getLineNumber();
    if (line !== null) {
      location += `:${line}:${this.getColumnNumber()}`;
    }
    const name = this.getFunctionName();
    return name === null ? location : `${name} (${location})`;
  },
};

/** Define the methods `prototype` lacks, as V8 does: not enumerable. */
function completeCallSite(prototype: object): void {
  for (const [name, method] of Object.entries(callSiteDefaults)) {
    if (!Object.hasOwn(prototype, name)) {
      defineProperty(prototype, name, { value: method, writable: true, configurable: true });
    }
  }
}

/** A frame Boa reported, as a V8 call site. */
class FrameCallSite {
  readonly #frame: Frame;
  constructor(frame: Frame) {
    this.#frame = frame;
  }
  getFunctionName(): string | null {
    return this.#frame[0];
  }
  getFileName(): string | undefined {
    return this.#frame[1] ?? undefined;
  }
  getLineNumber(): number | null {
    return this.#frame[2];
  }
  getColumnNumber(): number | null {
    return this.#frame[3];
  }
  isEval(): boolean {
    return this.#frame[4];
  }
}
completeCallSite(FrameCallSite.prototype);

/** The first line of a stack V8 formats: `Error.prototype.toString`. */
function header(target: object): string {
  // Typed as strings for String, which converts any value as V8 does.
  const { name, message } = target as { name?: string; message?: string };
  const named = name === undefined ? "Error" : String(name);
  const described = message === undefined ? "" : String(message);
  if (named === "") {
    return described;
  }
  return described === "" ? named : `${named}: ${described}`;
}

/** `Error.stackTraceLimit` as a frame count: none when it is not a number. */
function stackTraceLimit(): number {
  const limit: unknown = Error.stackTraceLimit;
  return typeof limit === "number" && limit > 0 ? Math.min(limit, 2 ** 32 - 1) : 0;
}

function installCaptureStackTrace(frames: StackFrames): void {
  // A prepareStackTrace that captures a stack gets the default format, as on
  // V8, instead of calling itself.
  let preparing = false;
  defineProperty(Error, "captureStackTrace", {
    value: function captureStackTrace(target: object, constructorOpt?: Function): void {
      if ((typeof target !== "object" && typeof target !== "function") || target === null) {
        throw new TypeError("Error.captureStackTrace requires an object");
      }
      const sites = frames(constructorOpt, stackTraceLimit()).map(
        (frame) => new FrameCallSite(frame) as unknown as CallSite,
      );
      const prepare = Error.prepareStackTrace;
      let stack: unknown;
      if (typeof prepare === "function" && !preparing) {
        preparing = true;
        try {
          stack = prepare(target as Error, sites);
        } finally {
          preparing = false;
        }
      } else {
        stack = [header(target), ...sites.map((site) => `    at ${site.toString()}`)].join("\n");
      }
      defineProperty(target, "stack", {
        value: stack,
        writable: true,
        configurable: true,
      });
    },
    writable: true,
    configurable: true,
  });
  if (!Object.hasOwn(Error, "stackTraceLimit")) {
    defineProperty(Error, "stackTraceLimit", {
      value: 10,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

/** The prototype of the engine's own call sites, read from one capture. */
function nativeCallSitePrototype(): object | undefined {
  const hadPrepare = Object.hasOwn(Error, "prepareStackTrace");
  const previous = Error.prepareStackTrace;
  let site: CallSite | undefined;
  Error.prepareStackTrace = (_error, sites) => {
    site = sites[0];
    return "";
  };
  try {
    const target: { stack?: unknown } = {};
    Error.captureStackTrace?.(target);
    void target.stack;
  } finally {
    if (hadPrepare) {
      Error.prepareStackTrace = previous;
    } else {
      delete Error.prepareStackTrace;
    }
  }
  return site === undefined ? undefined : (Object.getPrototypeOf(site) as object);
}

const frames = globalThis.__fetchletStackFrames;
delete globalThis.__fetchletStackFrames;
if (typeof Error.captureStackTrace !== "function") {
  if (frames !== undefined) {
    installCaptureStackTrace(frames);
  }
} else {
  const prototype = nativeCallSitePrototype();
  if (prototype !== undefined) {
    completeCallSite(prototype);
  }
}
