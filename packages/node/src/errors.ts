// Node's errors carry a `code` such as ERR_INVALID_ARG_TYPE, which callers
// test instead of the message.

type ErrorClass = new (message?: string) => Error;

export type NodeError = Error & { code: string };

export function nodeError(Base: ErrorClass, code: string, message: string): NodeError {
  const error = new Base(message) as NodeError;
  error.code = code;
  return error;
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "function") {
    return `function ${value.name}`;
  }
  if (typeof value === "object") {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return name ? `an instance of ${name}` : "an object";
  }
  let shown =
    typeof value === "string"
      ? `'${value}'`
      : typeof value === "bigint"
        ? `${value}n`
        : String(value);
  if (shown.length > 28) {
    shown = `${shown.slice(0, 25)}...`;
  }
  return `type ${typeof value} (${shown})`;
}

export function invalidArgType(name: string, expected: string, actual: unknown): NodeError {
  return nodeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be ${expected}. Received ${describe(actual)}`,
  );
}

export function invalidArgValue(name: string, value: unknown, reason = "is invalid"): NodeError {
  return nodeError(
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    `The argument '${name}' ${reason}. Received ${describe(value)}`,
  );
}

export function outOfRange(name: string, range: string, value: unknown): NodeError {
  return nodeError(
    RangeError,
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`,
  );
}

export function validateFunction(value: unknown, name: string): asserts value is Function {
  if (typeof value !== "function") {
    throw invalidArgType(name, "of type function", value);
  }
}

export function validateInteger(
  value: unknown,
  name: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (typeof value !== "number") {
    throw invalidArgType(name, "of type number", value);
  }
  if (!Number.isInteger(value)) {
    throw outOfRange(name, "an integer", value);
  }
  if (value < min || value > max) {
    throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  }
}

/** Errors for APIs that fetchlet does not provide, thrown when they are called. */
export function unavailable(name: string): NodeError {
  return nodeError(Error, "ERR_METHOD_NOT_IMPLEMENTED", `${name} is not available in fetchlet`);
}
