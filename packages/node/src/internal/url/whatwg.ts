// The profile's WHATWG URL classes.

const runtime = globalThis as unknown as {
  URL: typeof globalThis.URL;
  URLSearchParams: typeof globalThis.URLSearchParams;
};

export const URL = runtime.URL;
export const URLSearchParams = runtime.URLSearchParams;
