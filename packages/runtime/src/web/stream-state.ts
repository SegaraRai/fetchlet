import { ReadableStream } from "web-streams-polyfill";

/**
 * Provider seam for web-streams-polyfill 4.5.1's disturbed state.
 *
 * Fetch needs the Streams internal disturbed slot, which has no public JS
 * getter. Keep this version-specific access here, with an exact dependency
 * and conformance coverage for direct reads, cancellation and tee.
 */
export function isDisturbed(stream: unknown): boolean {
  if (!(stream instanceof ReadableStream)) {
    throw new TypeError("This Fetch profile requires its configured Streams provider");
  }
  const state = (stream as unknown as { _disturbed?: boolean })._disturbed;
  if (typeof state !== "boolean") {
    throw new TypeError("The configured Streams provider has an incompatible state layout");
  }
  return state;
}

let byteStreamSupport: boolean | undefined;

/** Byte controllers need a working transfer operation from the configured host. */
export function supportsByteStreams(): boolean {
  if (byteStreamSupport !== undefined) {
    return byteStreamSupport;
  }
  try {
    const original = new ArrayBuffer(1);
    const cloned = globalThis.structuredClone(original, {
      transfer: [original],
    });
    byteStreamSupport = original.byteLength === 0 && cloned.byteLength === 1;
  } catch {
    byteStreamSupport = false;
  }
  return byteStreamSupport;
}

/**
 * Provider seam for web-streams-polyfill 4.5.1's async iterator prototype.
 *
 * Web IDL async iterable interfaces give their iterator prototype
 * %AsyncIteratorPrototype% as [[Prototype]], which supplies
 * [Symbol.asyncIterator]. The provider uses a plain object with its own
 * [Symbol.asyncIterator]; reparent it once at profile setup.
 */
export function conformAsyncIteratorPrototype() {
  const asyncIteratorPrototype = Object.getPrototypeOf(
    Object.getPrototypeOf(async function* () {}).prototype,
  );
  const iteratorPrototype = Object.getPrototypeOf(new ReadableStream().values());
  if (Object.getPrototypeOf(iteratorPrototype) === asyncIteratorPrototype) {
    return;
  }
  delete iteratorPrototype[Symbol.asyncIterator];
  Object.setPrototypeOf(iteratorPrototype, asyncIteratorPrototype);
}
