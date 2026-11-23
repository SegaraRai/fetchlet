// Function bindings: env.NAME is a frozen object whose methods call Rust
// functions. A sync method returns the outcome of function.call; an async one
// returns a Promise that the host pump settles with its outcome.

import { dispatchJson, hostError, putBytes, takeBytes } from "./host.ts";
import { lentChannel, placeAt } from "./places.ts";
import type {
  Completion,
  FunctionErrorDescription,
  FunctionMethods,
  FunctionOutcome,
  Ticket,
} from "./wire.ts";

interface PendingCall {
  binding: string;
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const pendingCalls = new Map<Ticket, PendingCall>();

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

/** The call's value, with the byte arrays and channels Rust placed in it. */
function settle(outcome: FunctionOutcome, binding: string, method: string): unknown {
  if (!outcome.ok) {
    throw functionError(outcome.error, binding, method);
  }
  // Take every buffer first, so the byte store is left empty even if a
  // channel cannot be built.
  const bytes = outcome.bytes.map(({ path, handle }) => ({ path, item: takeBytes(handle) }));
  let value = outcome.value;
  for (const { path, item } of bytes) {
    value = placeAt(value, path, item);
  }
  for (const { path, channel } of outcome.channels) {
    value = placeAt(value, path, lentChannel(channel));
  }
  return value;
}

/** Settle the call a completion belongs to; false if it is not a call. */
export function completeCall(completion: Completion): boolean {
  const pending = pendingCalls.get(completion.id);
  if (!pending) {
    return false;
  }
  pendingCalls.delete(completion.id);
  try {
    pending.resolve(settle(completion.result as FunctionOutcome, pending.binding, pending.method));
  } catch (error) {
    pending.reject(error);
  }
  return true;
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/**
 * The call message. Arguments cross as JSON.stringify encodes them, so
 * undefined becomes null and a value it cannot encode, such as a BigInt,
 * throws its TypeError; each ArrayBuffer or view becomes null instead, and
 * its bytes travel in one buffer of the byte store, cut into parts by path.
 */
function callMessage(binding: string, method: string, args: unknown[]): string {
  const parts: { path: string[]; bytes: Uint8Array }[] = [];
  // The path of each object whose properties the replacer visits.
  const paths = new WeakMap<object, string[]>();
  const json = JSON.stringify(args, function (this: unknown, key: string, value: unknown) {
    const holder = this as Record<string, unknown>;
    const parent = paths.get(holder);
    // The root's holder is a wrapper the replacer never saw as a value.
    const path = parent === undefined ? [] : [...parent, key];
    // The value before toJSON, which Node's Buffer defines.
    const raw = holder[key];
    if (path.length > 0 && isBinary(raw)) {
      const bytes = ArrayBuffer.isView(raw)
        ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        : new Uint8Array(raw);
      parts.push({ path, bytes });
      return null;
    }
    if (typeof value === "object" && value !== null) {
      paths.set(value, path);
    }
    return value;
  });
  let message = `{"binding":${JSON.stringify(binding)},"method":${JSON.stringify(method)},"args":${json}`;
  if (parts.length > 0) {
    const buffer = new Uint8Array(parts.reduce((total, part) => total + part.bytes.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      buffer.set(part.bytes, offset);
      offset += part.bytes.byteLength;
    }
    const layout = parts.map((part) => ({
      path: part.path,
      length: part.bytes.byteLength,
    }));
    // Store the buffer right before the message that takes it.
    message += `,"bytes":${JSON.stringify({ handle: putBytes(buffer), parts: layout })}`;
  }
  return `${message}}`;
}

/** The env value of a function binding. */
export function functionBinding(binding: string, methods: FunctionMethods): object {
  const target: Record<string, (...args: unknown[]) => unknown> = Object.create(null);
  for (const [method, kind] of Object.entries(methods)) {
    target[method] =
      kind === "sync"
        ? (...args: unknown[]) =>
            settle(
              dispatchJson<FunctionOutcome>("function.call", callMessage(binding, method, args)),
              binding,
              method,
            )
        : (...args: unknown[]) =>
            new Promise((resolve, reject) => {
              const ticket = dispatchJson<Ticket>(
                "function.start",
                callMessage(binding, method, args),
              );
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
