// The Node baseline for the benchmark: the example endpoints on node:http in
// one process, without the Rust host.
//
//   node tools/bench/node-server.mjs <config.json>
//
// The config is the example's config.json, plus `node`: "artifact" runs
// build/server.js in the main context, where @fetchlet/runtime keeps Node's
// own Request, Response, streams and timers; "bare" imports the
// framework-free handler directly. `/api/rust` and `/health.txt` mirror the
// axum routes, and the RUST binding answers in process like the Rust service.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import vm from "node:vm";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const client = resolve(config.build_directory, "client");

const env = {
  MESSAGE: config.message,
  RUST: {
    async fetch() {
      return Response.json({ message: "Rustサービスからの挨拶です。" });
    },
  },
};
globalThis.fetchlet = { env, waitUntil() {} };

let handle;
if (config.node === "bare") {
  const { app } = await import("./bare/app.mjs");
  handle = (request, clientAddress) => app(request, env, clientAddress);
} else {
  const file = resolve(config.build_directory, "server.js");
  vm.runInThisContext(await readFile(file, "utf8"), { filename: file });
  const exports = globalThis.fetchletExports;
  handle = async (request, clientAddress) => {
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    const wire = await exports.handle(
      { url: request.url, method: request.method, headers: [...request.headers], body },
      { clientAddress, env, waitUntil() {} },
    );
    const bytes = wire.body instanceof Uint8Array ? wire.body : new Uint8Array(wire.body);
    return new Response(wire.status === 204 || wire.status === 304 ? null : bytes, {
      status: wire.status,
      headers: wire.headers,
    });
  };
}

const types = { ".txt": "text/plain; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

async function staticFile(pathname) {
  const file = resolve(client, "." + decodeURIComponent(pathname));
  if (!file.startsWith(client + sep)) return undefined;
  try {
    return new Response(await readFile(file), {
      headers: { "content-type": types[extname(file)] ?? "application/octet-stream" },
    });
  } catch {
    return undefined;
  }
}

async function respond(incoming, outgoing) {
  const origin = "http://" + incoming.headers.host;
  const url = new URL(incoming.url, origin);
  let response;
  if (url.pathname === "/api/rust") {
    response = Response.json({ message: "served by axum" });
  } else {
    response = incoming.method === "GET" ? await staticFile(url.pathname) : undefined;
  }
  if (!response) {
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const request = new Request(url, {
      method: incoming.method,
      headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
        Array.isArray(value) ? value.map((item) => [name, item]) : [[name, value]],
      ),
      body: hasBody ? incoming : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    response = await handle(request, incoming.socket.remoteAddress?.replace(/^::ffff:/, ""));
  }
  const body = new Uint8Array(await response.arrayBuffer());
  const headers = [...response.headers].filter(([name]) => name !== "content-length");
  outgoing.writeHead(response.status, [...headers.flat(), "content-length", String(body.length)]);
  outgoing.end(body);
}

const server = createServer((incoming, outgoing) => {
  respond(incoming, outgoing).catch((error) => {
    process.stderr.write(String(error?.stack ?? error) + "\n");
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  });
});
const [host, port] = config.listen.split(/:(?=\d+$)/);
server.listen(Number(port), host, () => {
  const address = server.address();
  console.log(`FETCHLET_LISTENING http://${address.address}:${address.port}`);
});
