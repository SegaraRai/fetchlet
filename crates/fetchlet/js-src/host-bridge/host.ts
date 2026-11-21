// The host bindings Rust installs before evaluating the bridge. The bridge
// takes them off the global object before anything else runs.

const nativeDispatch = globalThis.__fetchletHost!;
// Body bytes cross the bridge as typed arrays in the invocation's byte store;
// JSON messages carry their handles.
const takeBytes = globalThis.__fetchletTakeBytes!;
const putBytes = globalThis.__fetchletPutBytes!;

delete globalThis.__fetchletHost;
delete globalThis.__fetchletTakeBytes;
delete globalThis.__fetchletPutBytes;

export { nativeDispatch, putBytes, takeBytes };

export function hostError(description: HostErrorDescription): Error {
  const error = new Error(description.message) as Error & { code: string };
  error.name = "FetchletHostError";
  error.code = description.code;
  return error;
}

export function dispatch<T = unknown>(operation: string, input: unknown): T {
  const reply = JSON.parse(nativeDispatch(operation, JSON.stringify(input))) as HostReply<T>;
  if (!reply.ok) {
    throw hostError(reply.error);
  }
  return reply.value;
}
