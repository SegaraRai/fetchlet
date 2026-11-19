// The framework features the example checks verify. Each check names the
// features it covers; the reference page combines the recorded results with
// the declarations below into one table per example.

/** Feature IDs and the column titles of the reference table. */
export const features = {
  ssr: "SSR",
  "streaming-ssr": "Streaming SSR",
  hydration: "Hydration",
  navigation: "Client navigation",
  assets: "Assets",
  json: "JSON endpoints",
  form: "Form posts",
  cookies: "Cookies",
  "server-functions": "Server functions",
  bindings: "Bindings",
  "client-address": "Client address",
  "internal-fetch": "In-process Rust API",
  functions: "Function calls",
  "rust-routes": "Rust routes",
  "body-budget": "Body budget",
  "streaming-upload": "Streaming uploads",
  "wait-until": "waitUntil",
  concurrency: "Concurrency",
} as const;

export type Feature = keyof typeof features;

/**
 * Features an example cannot have, with the reason. Every other feature is
 * either covered by a recorded check or untested.
 */
export const unsupported: Record<string, Partial<Record<Feature, string>>> = {
  "vanilla-cli": Object.fromEntries(
    (Object.keys(features) as Feature[])
      .filter((feature) => !["functions", "bindings"].includes(feature))
      .map((feature) => [feature, "A command line program calls functions without HTTP requests"]),
  ),
  "nuxt-axum": {
    "streaming-ssr": "Nuxt renders with Vue's renderToString and buffers the response",
  },
  "honox-tauri": {
    "client-address": "Requests come from the webview through the URI scheme, without a peer",
    "streaming-upload": "Tauri's URI scheme handler receives the whole request body",
    "streaming-ssr": "Tauri's UriSchemeResponder takes a complete body",
  },
  "sveltekit-axum-tauri-desktop": {
    "client-address": "Requests come from the webview through the URI scheme, without a peer",
    "streaming-upload": "Tauri's URI scheme handler receives the whole request body",
    "streaming-ssr": "Tauri's UriSchemeResponder takes a complete body",
  },
};
