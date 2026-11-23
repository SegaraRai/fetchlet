// Function bindings: env.NAME is a frozen object whose methods call Rust
// functions. A sync method returns the outcome of function.call; an async one
// returns a Promise that the host pump settles with its outcome.

import { dispatch, hostError } from "./host.ts";
import type { Completion, FunctionErrorDescription, FunctionMethods } from "./wire.ts";

type Outcome =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      error: FunctionErrorDescription;
    };

interface PendingCall {
  binding: string;
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const pendingCalls = new Map<number, PendingCall>();

export function hasPendingCalls(): boolean {
  return pendingCalls.size > 0;
}

function functionError(error: FunctionErrorDescription, binding: string, method: string): Error {
  switch (error.kind) {
    case "arguments":
      // Rust could not read the arguments as the method's types.
      return new TypeError(`Invalid arguments for ${binding}.${method}`);

    case "application": {
      const failure = new Error(error.message) as Error & { code?: string };
      if (error.code !== null) {
        failure.code = error.code;
      }
      return failure;
    }

    default:
      return hostError({
        code: error.code ?? "TRANSPORT",
        message: error.message,
      });
  }
}

function settle(outcome: Outcome, binding: string, method: string): unknown {
  if (outcome.ok) {
    return outcome.value;
  }
  throw functionError(outcome.error, binding, method);
}

/** Settle the call a completion belongs to; false if it is not a call. */
export function completeCall(completion: Completion): boolean {
  const pending = pendingCalls.get(completion.id);
  if (!pending) {
    return false;
  }
  pendingCalls.delete(completion.id);
  try {
    pending.resolve(settle(completion.result as Outcome, pending.binding, pending.method));
  } catch (error) {
    pending.reject(error);
  }
  return true;
}

/** The env value of a function binding. */
export function functionBinding(binding: string, methods: FunctionMethods): object {
  const target: Record<string, (...args: unknown[]) => unknown> = Object.create(null);
  for (const [method, kind] of Object.entries(methods)) {
    // Arguments cross as JSON.stringify encodes them: undefined becomes null,
    // and a value it cannot encode, such as a BigInt, throws its TypeError.
    target[method] =
      kind === "sync"
        ? (...args: unknown[]) =>
            settle(
              dispatch<Outcome>("function.call", {
                binding,
                method,
                args,
              }),
              binding,
              method,
            )
        : (...args: unknown[]) =>
            new Promise((resolve, reject) => {
              const ticket = dispatch<number>("function.start", {
                binding,
                method,
                args,
              });
              pendingCalls.set(ticket, {
                binding,
                method,
                resolve,
                reject,
              });
            });
  }
  return Object.freeze(target);
}
