// Exports that isolate the stages of one fetch invocation, for
// tools/bench/src/bin/invoke.rs. Built with the shared builder like bare/.

import { wireRequest, wireResponse } from "fetchlet/runtime";
import { createFetchHandler, getBindings } from "fetchlet/runtime/handler";

import { app, type Bindings } from "../bare/app.ts";

type Wire = Parameters<typeof wireRequest>[0];

const empty = new Uint8Array(0);

/** A generic call: the Rust → JS → Rust round trip with JSON values. */
export function noop() {
  return 0;
}

/** A Fetch entry that answers the wire request without Web API objects. */
export function rawHandle() {
  return { status: 200, headers: [["content-type", "text/plain"]], body: empty };
}

/** Builds the Request but answers with a wire object. */
export function requestOnlyHandle(input: Wire) {
  const request = wireRequest(input);
  request.headers.get("host");
  return { status: 200, headers: [["content-type", "text/plain"]], body: empty };
}

/** Answers with a Response read through wireResponse, without a Request. */
export function responseOnlyHandle() {
  return wireResponse(Response.json({ clientAddress: "127.0.0.1", message: "m" }));
}

/** The bare handler, as the bench serves it. */
const bindings = () => getBindings<Bindings>();

export const handle = createFetchHandler(
  (request, context: { clientAddress?: string } | undefined) =>
    app(request, bindings(), context?.clientAddress),
);

/**
 * Runs one stage `count` times inside JavaScript and returns microseconds
 * per iteration, so the engine's own cost is visible without the bridge.
 */
export async function jsLoop(stage: string, count: number): Promise<number> {
  const wire: Wire = {
    url: "http://127.0.0.1/api/context",
    method: "GET",
    headers: [
      ["host", "127.0.0.1"],
      ["accept", "*/*"],
    ],
    body: null,
  };
  const echo: Wire = {
    url: "http://127.0.0.1/api/echo",
    method: "POST",
    headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode(JSON.stringify({ message: "bench", items: [1, 2, 3] })),
  };
  const stages: Record<string, () => unknown> = {
    url: () => new URL(wire.url),
    headers: () => new Headers(wire.headers as [string, string][]),
    abortController: () => new AbortController(),
    stream: async () => {
      const reader = new Response("x").body!.getReader();
      while (!(await reader.read()).done) {}
    },
    arrayBuffer: () => new Response("x").arrayBuffer(),
    jsonStringify: () => JSON.stringify({ clientAddress: "127.0.0.1", message: "m" }),
    textEncode: () => new TextEncoder().encode('{"clientAddress":"127.0.0.1","message":"m"}'),
    request: () => wireRequest(wire),
    response: () => Response.json({ clientAddress: "127.0.0.1", message: "m" }),
    wireResponse: () => wireResponse(Response.json({ clientAddress: "127.0.0.1", message: "m" })),
    readJson: () => wireRequest(echo).json(),
    serviceFetch: async () => (await bindings().RUST.fetch("https://fetchlet.internal/")).json(),
    context: () => handle(wire, { clientAddress: "127.0.0.1" }),
    echo: () => handle(echo, { clientAddress: "127.0.0.1" }),
  };
  const run = stages[stage];
  if (!run) {
    throw new Error("unknown stage " + stage);
  }
  for (let index = 0; index < Math.min(count, 200); index++) {
    await run();
  }
  const start = performance.now();
  for (let index = 0; index < count; index++) {
    await run();
  }
  return ((performance.now() - start) * 1000) / count;
}
