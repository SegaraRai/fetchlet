// node:assert and node:assert/strict. The comparisons follow Node's; the
// messages of failed comparisons show both values with util.inspect rather
// than Node's line diff, and assert.ok cannot quote the source of the
// expression it was given.

import { isDeepEqual } from "./comparisons.ts";
import { invalidArgType, nodeError } from "./errors.ts";
import { inspect } from "./util.ts";

interface AssertionErrorOptions {
  message?: string | Error;
  actual?: unknown;
  expected?: unknown;
  operator?: string;
  stackStartFn?: Function;
}

export class AssertionError extends Error {
  actual: unknown;
  expected: unknown;
  operator: string | undefined;
  generatedMessage: boolean;
  code = "ERR_ASSERTION";

  constructor(options: AssertionErrorOptions) {
    if (options === null || typeof options !== "object") {
      throw invalidArgType("options", "of type object", options);
    }
    const { message, actual, expected, operator } = options;
    super(message === undefined ? describeFailure(actual, expected, operator) : String(message));
    this.name = "AssertionError";
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
    this.generatedMessage = message === undefined;
  }

  toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

const show = (value: unknown) => inspect(value, { depth: 1000 });

const headers: Record<string, string> = {
  deepStrictEqual: "Expected values to be strictly deep-equal:",
  strictEqual: "Expected values to be strictly equal:",
  deepEqual: "Expected values to be loosely deep-equal:",
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
};

function describeFailure(actual: unknown, expected: unknown, operator?: string): string {
  switch (operator) {
    case "deepStrictEqual":
    case "strictEqual":
      return `${headers[operator]}\n\n${show(actual)} !== ${show(expected)}\n`;

    case "deepEqual":
      return `${headers[operator]}\n\n${show(actual)}\n\nshould loosely deep-equal\n\n${show(expected)}`;

    case "notDeepStrictEqual":
    case "notStrictEqual":
    case "notDeepEqual":
      return `${headers[operator]} ${show(expected)}`;

    case "==":
    case "!=":
      return `${show(actual)} ${operator} ${show(expected)}`;

    case "fail":
      return "Failed";

    default:
      return `${show(actual)} ${operator ?? "=="} ${show(expected)}`;
  }
}

function fail(
  actual: unknown,
  expected: unknown,
  message: string | Error | undefined,
  operator: string,
  stackStartFn: Function,
): never {
  if (message instanceof Error) {
    throw message;
  }
  const error = new AssertionError({
    actual,
    expected,
    message,
    operator,
  });
  (Error as { captureStackTrace?: (target: object, fn: Function) => void }).captureStackTrace?.(
    error,
    stackStartFn,
  );
  throw error;
}

function innerOk(
  stackStartFn: Function,
  argumentCount: number,
  value: unknown,
  message?: string | Error,
) {
  if (value) {
    return;
  }
  if (message instanceof Error) {
    throw message;
  }
  const generated =
    argumentCount === 0
      ? "No value argument passed to `assert.ok()`"
      : "The expression evaluated to a falsy value:\n\n  " + `assert.ok(${show(value)})\n`;
  const error = new AssertionError({
    actual: value,
    expected: true,
    message: message ?? generated,
    operator: "==",
  });
  error.generatedMessage = message === undefined;
  (Error as { captureStackTrace?: (target: object, fn: Function) => void }).captureStackTrace?.(
    error,
    stackStartFn,
  );
  throw error;
}

export function ok(value?: unknown, message?: string | Error): asserts value {
  innerOk(ok, arguments.length, value, message);
}

function failFunction(message?: string | Error): never;
function failFunction(
  actual: unknown,
  expected: unknown,
  message?: string | Error,
  operator?: string,
): never;
function failFunction(...args: unknown[]): never {
  if (args.length < 2) {
    const [message] = args as [string | Error | undefined];
    if (message instanceof Error) {
      throw message;
    }
    throw new AssertionError({
      message: message ?? "Failed",
      operator: "fail",
    });
  }
  const [actual, expected, message, operator = "!="] = args as [
    unknown,
    unknown,
    string | Error | undefined,
    string | undefined,
  ];
  fail(actual, expected, message, operator, failFunction);
}

export { failFunction as fail };

export function equal(actual: unknown, expected: unknown, message?: string | Error) {
  // eslint-disable-next-line eqeqeq
  if (!(actual == expected || (Number.isNaN(actual) && Number.isNaN(expected)))) {
    fail(actual, expected, message, "==", equal);
  }
}

export function notEqual(actual: unknown, expected: unknown, message?: string | Error) {
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
    fail(actual, expected, message, "!=", notEqual);
  }
}

export function strictEqual(actual: unknown, expected: unknown, message?: string | Error) {
  if (!Object.is(actual, expected)) {
    fail(actual, expected, message, "strictEqual", strictEqual);
  }
}

export function notStrictEqual(actual: unknown, expected: unknown, message?: string | Error) {
  if (Object.is(actual, expected)) {
    fail(actual, expected, message, "notStrictEqual", notStrictEqual);
  }
}

export function deepEqual(actual: unknown, expected: unknown, message?: string | Error) {
  if (!isDeepEqual(actual, expected, false)) {
    fail(actual, expected, message, "deepEqual", deepEqual);
  }
}

export function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error) {
  if (isDeepEqual(actual, expected, false)) {
    fail(actual, expected, message, "notDeepEqual", notDeepEqual);
  }
}

export function deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error) {
  if (!isDeepEqual(actual, expected, true)) {
    fail(actual, expected, message, "deepStrictEqual", deepStrictEqual);
  }
}

export function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error) {
  if (isDeepEqual(actual, expected, true)) {
    fail(actual, expected, message, "notDeepStrictEqual", notDeepStrictEqual);
  }
}

export function ifError(value: unknown) {
  if (value === null || value === undefined) {
    return;
  }
  let message = "ifError got unwanted exception: ";
  if (typeof value === "object" && typeof (value as Error).message === "string") {
    message += (value as Error).message || (value as Error).constructor?.name;
  } else {
    message += show(value);
  }
  const error = new AssertionError({
    actual: value,
    expected: null,
    operator: "ifError",
    message,
  });
  error.generatedMessage = false;
  throw error;
}

function checkMatch(
  string: unknown,
  regexp: RegExp,
  message: string | Error | undefined,
  matching: boolean,
  stackStartFn: Function,
) {
  if (!(regexp instanceof RegExp)) {
    throw invalidArgType("regexp", "an instance of RegExp", regexp);
  }
  if (typeof string === "string" && regexp.test(string) === matching) {
    return;
  }
  if (message instanceof Error) {
    throw message;
  }
  const generated =
    typeof string !== "string"
      ? 'The "string" argument must be of type string. Received type ' +
        `${typeof string} (${show(string)})`
      : (matching
          ? "The input did not match the regular expression "
          : "The input was expected to not match the regular expression ") +
        `${show(regexp)}. Input:\n\n${show(string)}\n`;
  const error = new AssertionError({
    actual: string,
    expected: regexp,
    message: message ?? generated,
    operator: matching ? "match" : "doesNotMatch",
  });
  error.generatedMessage = message === undefined;
  (Error as { captureStackTrace?: (target: object, fn: Function) => void }).captureStackTrace?.(
    error,
    stackStartFn,
  );
  throw error;
}

export function match(string: string, regexp: RegExp, message?: string | Error) {
  checkMatch(string, regexp, message, true, match);
}

export function doesNotMatch(string: string, regexp: RegExp, message?: string | Error) {
  checkMatch(string, regexp, message, false, doesNotMatch);
}

// throws, rejects and their negations

type Expected = Function | RegExp | object | undefined;

const NO_EXCEPTION = Symbol("no exception");

function getActual(fn: unknown): unknown {
  if (typeof fn !== "function") {
    throw invalidArgType("fn", "of type function", fn);
  }
  try {
    fn();
  } catch (error) {
    return error;
  }
  return NO_EXCEPTION;
}

async function waitActual(promiseFn: unknown): Promise<unknown> {
  let promise: unknown;
  if (typeof promiseFn === "function") {
    promise = promiseFn();
    if (!isThenable(promise)) {
      throw nodeError(
        TypeError,
        "ERR_INVALID_RETURN_VALUE",
        'Expected instance of Promise to be returned from the "promiseFn" function but got ' +
          `${typeof promise}.`,
      );
    }
  } else if (isThenable(promiseFn)) {
    promise = promiseFn;
  } else {
    throw invalidArgType("promiseFn", "of type function or an instance of Promise", promiseFn);
  }
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return NO_EXCEPTION;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function expectedName(expected: Expected): string {
  if (typeof expected === "function" && expected.name) {
    return ` (${expected.name})`;
  }
  return "";
}

function matchesExpected(
  actual: unknown,
  expected: Expected,
  message: string | Error | undefined,
  stackStartFn: Function,
): void {
  if (typeof expected === "function") {
    if (expected.prototype !== undefined && actual instanceof expected) {
      return;
    }
    if (Error.isPrototypeOf(expected) || expected === Error) {
      const received = (actual as { constructor?: { name?: string } } | null)?.constructor?.name;
      const error = new AssertionError({
        actual,
        expected,
        operator: stackStartFn.name,
        message:
          message ??
          `The error is expected to be an instance of "${expected.name}". ` +
            `Received "${received}"

Error message:

${(actual as Error)?.message}`,
      });
      error.generatedMessage = message === undefined;
      throw error;
    }
    const result = (expected as (error: unknown) => unknown).call({}, actual);
    if (result !== true) {
      const error = new AssertionError({
        actual,
        expected,
        operator: stackStartFn.name,
        message:
          message ??
          `The ${expected.name ? `"${expected.name}" validation function` : "validation function"} ` +
            `is expected to return "true". Received ${show(result)}\n\nCaught error:\n\n${show(actual)}`,
      });
      error.generatedMessage = message === undefined;
      throw error;
    }
    return;
  }
  if (expected instanceof RegExp) {
    if (expected.test(String(actual))) {
      return;
    }
    const error = new AssertionError({
      actual,
      expected,
      operator: stackStartFn.name,
      message:
        message ??
        `The input did not match the regular expression ${show(expected)}. ` +
          `Input:\n\n${show(String(actual))}\n`,
    });
    error.generatedMessage = message === undefined;
    throw error;
  }
  if (expected !== null && typeof expected === "object") {
    const keys = Object.keys(expected);
    if (expected instanceof Error) {
      keys.push("name", "message");
    }
    for (const key of keys) {
      const want = (expected as Record<string, unknown>)[key];
      const have = (actual as Record<string, unknown> | null)?.[key];
      const same =
        want instanceof RegExp && typeof have === "string"
          ? want.test(have)
          : isDeepEqual(have, want, true);
      if (!same) {
        fail(
          actual,
          expected,
          message ??
            `Expected values to be strictly deep-equal:\n\n${show(have)} !== ${show(want)}\n`,
          stackStartFn.name,
          stackStartFn,
        );
      }
    }
    return;
  }
  throw invalidArgType(
    "expected",
    "of type function or an instance of Error, RegExp, or Object",
    expected,
  );
}

function expectsError(
  stackStartFn: Function,
  actual: unknown,
  expected: Expected | string,
  message?: string | Error,
) {
  if (typeof expected === "string") {
    message = expected;
    expected = undefined;
  }
  if (actual === NO_EXCEPTION) {
    const details = `${expectedName(expected)}${message ? `: ${String(message)}` : "."}`;
    fail(
      undefined,
      expected,
      message instanceof Error
        ? message
        : `Missing expected ${stackStartFn.name === "rejects" ? "rejection" : "exception"}${details}`,
      stackStartFn.name,
      stackStartFn,
    );
  }
  if (expected !== undefined) {
    matchesExpected(actual, expected, message as string | undefined, stackStartFn);
  }
}

function expectsNoError(
  stackStartFn: Function,
  actual: unknown,
  expected: Expected | string,
  message?: string | Error,
) {
  if (actual === NO_EXCEPTION) {
    return;
  }
  if (typeof expected === "string") {
    message = expected;
    expected = undefined;
  }
  if (
    expected === undefined ||
    (typeof expected === "function" &&
      expected.prototype !== undefined &&
      actual instanceof expected)
  ) {
    const kind = stackStartFn.name === "doesNotReject" ? "rejection" : "exception";
    const details = message ? `: ${String(message)}` : ".";
    fail(
      actual,
      expected,
      `Got unwanted ${kind}${details}\nActual message: "${(actual as Error)?.message}"`,
      stackStartFn.name,
      stackStartFn,
    );
  }
  throw actual;
}

export function throws(fn: () => unknown, expected?: Expected | string, message?: string | Error) {
  expectsError(throws, getActual(fn), expected, message);
}

export async function rejects(
  promiseFn: Promise<unknown> | (() => Promise<unknown>),
  expected?: Expected | string,
  message?: string | Error,
) {
  expectsError(rejects, await waitActual(promiseFn), expected, message);
}

export function doesNotThrow(
  fn: () => unknown,
  expected?: Expected | string,
  message?: string | Error,
) {
  expectsNoError(doesNotThrow, getActual(fn), expected, message);
}

export async function doesNotReject(
  promiseFn: Promise<unknown> | (() => Promise<unknown>),
  expected?: Expected | string,
  message?: string | Error,
) {
  expectsNoError(doesNotReject, await waitActual(promiseFn), expected, message);
}

type Assert = typeof ok & {
  ok: typeof ok;
  fail: typeof failFunction;
  equal: typeof equal;
  notEqual: typeof notEqual;
  strictEqual: typeof strictEqual;
  notStrictEqual: typeof notStrictEqual;
  deepEqual: typeof deepEqual;
  notDeepEqual: typeof notDeepEqual;
  deepStrictEqual: typeof deepStrictEqual;
  notDeepStrictEqual: typeof notDeepStrictEqual;
  throws: typeof throws;
  doesNotThrow: typeof doesNotThrow;
  rejects: typeof rejects;
  doesNotReject: typeof doesNotReject;
  ifError: typeof ifError;
  match: typeof match;
  doesNotMatch: typeof doesNotMatch;
  AssertionError: typeof AssertionError;
  strict: Assert;
};

const members = {
  fail: failFunction,
  equal,
  notEqual,
  strictEqual,
  notStrictEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  match,
  doesNotMatch,
  AssertionError,
};

function assert(value?: unknown, message?: string | Error): asserts value {
  innerOk(assert, arguments.length, value, message);
}

function strictAssert(value?: unknown, message?: string | Error): asserts value {
  innerOk(strictAssert, arguments.length, value, message);
}

const legacy = Object.assign(assert, members, { ok }) as unknown as Assert;
export const strict = Object.assign(strictAssert, members, {
  ok,
  equal: strictEqual,
  notEqual: notStrictEqual,
  deepEqual: deepStrictEqual,
  notDeepEqual: notDeepStrictEqual,
}) as unknown as Assert;
legacy.strict = strict;
strict.strict = strict;

export default legacy;
