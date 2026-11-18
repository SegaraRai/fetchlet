// promisify, callbackify, inherits, deprecate, debuglog and isArray.

import { invalidArgType, validateFunction } from "../errors/errors.ts";
import { emitWarning } from "../process/warnings.ts";

const customPromisify = Symbol.for("nodejs.util.promisify.custom");

type Callback = (error: unknown, ...values: unknown[]) => void;

export const promisify = Object.assign(
  function promisify(original: Function): Function {
    validateFunction(original, "original");
    const custom = (original as { [customPromisify]?: Function })[customPromisify];
    if (custom !== undefined) {
      validateFunction(custom, "util.promisify.custom");
      return custom;
    }
    function promisified(this: unknown, ...args: unknown[]) {
      return new Promise((resolve, reject) => {
        original.call(this, ...args, (error: unknown, value: unknown) => {
          if (error) {
            reject(error);
          } else {
            resolve(value);
          }
        });
      });
    }
    Object.setPrototypeOf(promisified, Object.getPrototypeOf(original));
    Object.defineProperty(promisified, customPromisify, {
      value: promisified,
    });
    return Object.defineProperties(promisified, Object.getOwnPropertyDescriptors(original));
  },
  {
    custom: customPromisify,
  },
);

export function callbackify(original: (...args: any[]) => Promise<unknown>) {
  validateFunction(original, "original");
  return function (this: unknown, ...args: unknown[]) {
    const callback = args.pop() as Callback;
    validateFunction(callback, "last argument");
    original.apply(this, args).then(
      (value) => queueMicrotask(() => callback(null, value)),
      (reason) => {
        const error =
          reason ||
          Object.assign(new Error("Promise was rejected with a falsy value"), {
            code: "ERR_FALSY_VALUE_REJECTION",
            reason,
          });
        queueMicrotask(() => callback(error));
      },
    );
  };
}

export function inherits(constructor: Function, superConstructor: Function) {
  if (typeof constructor !== "function") {
    throw invalidArgType("ctor", "of type function", constructor);
  }
  if (typeof superConstructor !== "function") {
    throw invalidArgType("superCtor", "of type function", superConstructor);
  }
  if (superConstructor.prototype === undefined) {
    throw invalidArgType("superCtor.prototype", "of type object", superConstructor.prototype);
  }
  Object.defineProperty(constructor, "super_", {
    value: superConstructor,
    writable: true,
    configurable: true,
  });
  Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
}

const deprecationsWarned = new Set<string>();

export function deprecate<T extends Function>(fn: T, message: string, code?: string): T {
  validateFunction(fn, "fn");
  let warned = false;
  const emit = () => {
    if (warned || (code !== undefined && deprecationsWarned.has(code))) {
      return;
    }
    warned = true;
    if (code !== undefined) {
      deprecationsWarned.add(code);
    }
    emitWarning(message, "DeprecationWarning", code);
  };
  function deprecated(this: unknown, ...args: unknown[]) {
    emit();
    return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
  }
  Object.setPrototypeOf(deprecated, fn);
  if (fn.prototype) {
    deprecated.prototype = fn.prototype;
  }
  return deprecated as unknown as T;
}

export function debuglog(_section: string) {
  const log = () => {};
  return Object.assign(log, {
    enabled: false,
  });
}

export const debug = debuglog;

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
