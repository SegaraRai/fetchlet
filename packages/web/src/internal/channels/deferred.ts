/** A promise with its settle functions, as channel views expose them. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/**
 * A promise to settle later. A rejection nobody awaits is not reported as
 * unhandled: a channel's `opened` or `closed` may go unobserved.
 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
