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
  "a WebSocket holds its instance while others serve requests",
  ["websocket"],
  async () => {
    const socket = new WebSocket(suite.base.replace(/^http/, "ws") + "/api/socket");
    const messages: string[] = [];
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
    const arrived = (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (messages.length >= count) {
            socket.removeEventListener("message", check);
            resolve();
          }
        };
        socket.addEventListener("message", check);
      });
    socket.addEventListener("message", (event) => messages.push(String(event.data)));
    await arrived(1);
    expect(messages).toStrictEqual(["ready"]);

    // Another instance answers while this connection is open.
    const page = await fetch(suite.base + "/about");
    expect(page.status).toBe(200);

    socket.send("one");
    socket.send("two");
    await arrived(3);
    expect(messages).toStrictEqual(["ready", "#1: one", "#2: two"]);
    socket.send("bye");
    const close = await closed;
    expect([close.code, close.reason, close.wasClean]).toStrictEqual([1000, "goodbye", true]);
  },
);
