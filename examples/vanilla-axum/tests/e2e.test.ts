import { commonChecks } from "@fetchlet-internal/tools-examples/common-checks";
import { exampleSuite } from "@fetchlet-internal/tools-examples/suite";
import { expect } from "vite-plus/test";

const suite = exampleSuite("vanilla-axum");

commonChecks(suite, {
  framework: "vanilla JavaScript",
  example: "vanilla-axum",
  message: "From vanilla JavaScript",
  assetPrefix: "/assets/",
  streaming: true,
  // Links load documents; there is no client-side router.
  clientNavigation: false,
  websocket: true,
});

suite.check("Rust calls a named export beside the Fetch handler", ["functions"], async () => {
  const response = await fetch(suite.base + "/api/greet?name=" + encodeURIComponent("axum"));
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    greeting: "Hello from JavaScript, axum",
  });
});

suite.check("unknown paths answer 404 from the handler", ["ssr"], async () => {
  const response = await fetch(suite.base + "/missing");
  expect(response.status).toBe(404);
  expect(await response.text()).toMatch(/Page not found/);
});
