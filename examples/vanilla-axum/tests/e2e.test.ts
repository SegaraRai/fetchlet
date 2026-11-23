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

suite.check(
  "a host channel streams a Rust job's steps as the response body",
  ["channels"],
  async () => {
    const response = await fetch(suite.base + "/api/progress?steps=3");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("step 1 of 3\nstep 2 of 3\nstep 3 of 3\n");
  },
);

suite.check("a host channel delivers messages to its WebSocket view", ["channels"], async () => {
  const response = await fetch(suite.base + "/api/progress/messages?steps=2");
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    messages: ["step 1 of 2\n", "step 2 of 2\n"],
    closed: { code: 1000, reason: "done" },
  });
});

suite.check("a channel service refuses options it does not accept", ["channels"], async () => {
  const response = await fetch(suite.base + "/api/progress/messages?steps=100");
  expect(response.status).toBe(400);
  expect(await response.json()).toStrictEqual({
    error: "host resource limit exceeded",
  });
});
