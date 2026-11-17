// Generates the TypeScript types and the fetch SDK of the Rust API from the
// OpenAPI document that the Rust handlers produce (`vp run generate:api`).
import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "openapi.json",
  output: {
    path: "web/lib/api",
    importFileExtension: ".ts",
    postProcess: [],
  },
  plugins: [
    {
      name: "@hey-api/client-fetch",
      // The in-process origin of the Rust API. Global `fetch` sends requests
      // for it to the axum router inside the same process, with no socket; the
      // Rust fetch policy admits no other origin.
      baseUrl: "https://rust.fetchlet.test",
    },
    "@hey-api/typescript",
    "@hey-api/sdk",
  ],
});
