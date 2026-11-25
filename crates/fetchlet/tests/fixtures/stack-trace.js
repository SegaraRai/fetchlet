// V8's stack trace API as libraries written for Node.js use it.

const callSiteMethods = [
  "getThis",
  "getTypeName",
  "getFunction",
  "getFunctionName",
  "getMethodName",
  "getFileName",
  "getLineNumber",
  "getColumnNumber",
  "getEvalOrigin",
  "isToplevel",
  "isEval",
  "isNative",
  "isConstructor",
  "isAsync",
  "isPromiseAll",
  "getPromiseIndex",
  "getScriptNameOrSourceURL",
  "toString",
];

// depd's getStack and callSiteLocation, which run when a module that uses
// depd loads.
function getStack() {
  const limit = Error.stackTraceLimit;
  const obj = {};
  const prep = Reflect.get(Error, "prepareStackTrace");
  Error.prepareStackTrace = (_obj, stack) => stack;
  Error.stackTraceLimit = Math.max(10, limit);
  Error.captureStackTrace(obj);
  const stack = obj.stack.slice(1);
  Error.prepareStackTrace = prep;
  Error.stackTraceLimit = limit;
  return stack;
}

function callSiteLocation(callSite) {
  let file = callSite.getFileName() || "<anonymous>";
  const line = callSite.getLineNumber();
  const colm = callSite.getColumnNumber();
  if (callSite.isEval()) {
    file = `${callSite.getEvalOrigin()}, ${file}`;
  }
  return [file, line, colm, callSite.getFunctionName()];
}

function depd() {
  return callSiteLocation(getStack()[1]);
}

function loadingModule() {
  return depd();
}

function withSites(capture) {
  const previous = Reflect.get(Error, "prepareStackTrace");
  Error.prepareStackTrace = (_target, sites) => sites;
  try {
    const target = {};
    capture(target);
    return target.stack;
  } finally {
    Error.prepareStackTrace = previous;
  }
}

function hidden() {
  return withSites((target) => Error.captureStackTrace(target, hidden));
}

function caller() {
  return hidden();
}

globalThis.fetchletExports = {
  depd() {
    const [file, line, column, name] = loadingModule();
    return {
      file: typeof file,
      line: typeof line,
      column: typeof column,
      name,
    };
  },
  methods() {
    const [site] = withSites((target) => Error.captureStackTrace(target));
    return callSiteMethods.filter((name) => typeof site[name] !== "function");
  },
  skipsThroughTheFunction() {
    return caller()[0].getFunctionName();
  },
  limit() {
    const previous = Error.stackTraceLimit;
    Error.stackTraceLimit = 1;
    try {
      return withSites((target) => Error.captureStackTrace(target)).length;
    } finally {
      Error.stackTraceLimit = previous;
    }
  },
  formatted() {
    const target = { message: "described" };
    Error.captureStackTrace(target);
    return target.stack;
  },
};
