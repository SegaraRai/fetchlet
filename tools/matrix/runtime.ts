// Runs the function, Hono, Web API probe and SvelteKit checks on each backend
// and the Node reference, and records results/runtime-matrix.json:
// `vp run test:matrix`.
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { hostBackends, startHost, type HostBackend } from "@fetchlet-internal/tools-workspace/lab";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import { describe, writeResult, writeText } from "@fetchlet-internal/tools-workspace/results";

interface Row {
  backend: HostBackend;
  suite: string;
  id: string;
  status: "pass" | "fail";
  durationMs: number;
  details?: unknown;
  error?: string;
}

interface WireResponse {
  status: number;
  headers: [string, string][];
  body: number[];
  diagnostics?: unknown;
}

const results: Row[] = [];
const functionsBundle = resolve(root, "artifacts/functions-hono.js");
const sveltekitBundle = resolve(root, "artifacts/sveltekit.js");

const request = (path: string, init: Record<string, unknown> = {}) => ({
  url: "https://fetchlet.invalid" + path,
  method: "GET",
  headers: [],
  body: null,
  ...init,
});
const text = (response: WireResponse) => new TextDecoder().decode(new Uint8Array(response.body));
const bytes = (value: string) => [...new TextEncoder().encode(value)];

async function check(
  backend: HostBackend,
  suite: string,
  id: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const started = performance.now();
  try {
    const details = await operation();
    results.push({
      backend,
      suite,
      id,
      status: "pass",
      durationMs: performance.now() - started,
      ...(details === undefined ? {} : { details }),
    });
  } catch (error) {
    results.push({
      backend,
      suite,
      id,
      status: "fail",
      durationMs: performance.now() - started,
      error: describe(error),
    });
  }
}

for (const backend of hostBackends) {
  const app = startHost(backend, functionsBundle);
  await check(backend, "functions", "sync-add", async () =>
    assert.equal(await app.call("add", [20, 22]), 42),
  );
  await check(backend, "functions", "object-unicode", async () =>
    assert.deepEqual(await app.call("transform", [{ name: "日本語😀", values: [1, 2, 3] }]), {
      greeting: "Hello, 日本語😀",
      sum: 6,
      nested: { ok: true },
    }),
  );
  await check(backend, "functions", "promise", async () =>
    assert.deepEqual(await app.call("asyncValue", [{ ok: true }]), { value: { ok: true } }),
  );
  await check(backend, "functions", "state-reuse", async () => {
    assert.equal(await app.call("increment"), 1);
    assert.equal(await app.call("increment"), 2);
  });
  await check(backend, "functions", "exception", async () =>
    assert.equal((await app.raw("throws")).ok, false),
  );
  await check(backend, "functions", "rejection", async () =>
    assert.equal((await app.raw("rejects")).ok, false),
  );
  await check(backend, "functions", "usable-after-errors", async () =>
    assert.deepEqual(await app.call("echo", [{ bytes: [0, 128, 255] }]), { bytes: [0, 128, 255] }),
  );
  await check(backend, "hono", "jsx-escaping", async () => {
    const res: WireResponse = await app.call("handle", [request("/hello/%3CAda%3E")]);
    assert.equal(res.status, 200);
    assert.match(text(res), /Hello, &lt;Ada&gt;/);
    assert.ok(res.headers.some(([k, v]) => k === "x-fetchlet" && v === "hono"));
  });
  await check(backend, "hono", "json-post", async () => {
    const res: WireResponse = await app.call("handle", [
      request("/echo", {
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: bytes('{"name":"日本語"}'),
      }),
    ]);
    assert.equal(res.status, 201);
    assert.deepEqual(JSON.parse(text(res)), { name: "日本語" });
  });
  await check(backend, "hono", "set-cookie", async () => {
    const res: WireResponse = await app.call("handle", [request("/cookies")]);
    assert.deepEqual(
      res.headers.filter(([k]) => k === "set-cookie").map(([, v]) => v),
      ["a=1", "b=2"],
    );
  });
  await check(backend, "hono", "stream-body", async () =>
    assert.equal(text(await app.call("handle", [request("/stream")])), "stream-ok"),
  );
  await check(backend, "hono", "not-found", async () =>
    assert.equal((await app.call("handle", [request("/missing")])).status, 404),
  );
  await check(backend, "web-api", "probe", async () => {
    const report = await app.call("probe");
    writeResult(`web-api-${backend}.json`, report);
    // A partial profile is recorded explicitly rather than reported as fully passing.
    assert.equal(
      report.summary.failed,
      0,
      JSON.stringify(
        report.checks
          .filter((x: { status: string }) => x.status === "fail")
          .map((x: { id: string; error: string }) => ({ id: x.id, error: x.error })),
      ),
    );
    return report.summary;
  });
  writeLog(backend, "functions", app.close());

  const kit = startHost(backend, sveltekitBundle);
  await check(backend, "sveltekit", "ssr-page", async () => {
    const res: WireResponse = await kit.call("handle", [request("/?name=Rust")]);
    assert.equal(res.status, 200, JSON.stringify(res.diagnostics));
    assert.match(text(res), /Hello, Rust/);
    assert.match(text(res), /SSR from Rust/);
  });
  await check(backend, "sveltekit", "escaped-query", async () => {
    const res: WireResponse = await kit.call("handle", [request("/?name=%3Cscript%3E")]);
    assert.equal(res.status, 200, JSON.stringify(res.diagnostics));
    assert.match(text(res), /&lt;script(?:&gt;|>)/);
  });
  await check(backend, "sveltekit", "json-endpoint", async () => {
    const res: WireResponse = await kit.call("handle", [
      request("/api/echo", {
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: bytes('{"ok":true}'),
      }),
    ]);
    assert.equal(res.status, 201);
    assert.deepEqual(JSON.parse(text(res)), { ok: true });
  });
  await check(backend, "sveltekit", "form-action", async () => {
    const res: WireResponse = await kit.call("handle", [
      request("/", {
        method: "POST",
        headers: [
          ["content-type", "application/x-www-form-urlencoded"],
          ["origin", "https://fetchlet.invalid"],
          ["accept", "application/json"],
          ["x-sveltekit-action", "true"],
        ],
        body: bytes("name=Alice"),
      }),
    ]);
    assert.equal(res.status, 200);
    const action = JSON.parse(text(res));
    assert.equal(action.type, "success");
    assert.match(action.data, /Alice/);
  });
  writeLog(backend, "sveltekit", kit.close());
}

const summary = Object.fromEntries(
  hostBackends.map((backend) => {
    const rows = results.filter((x) => x.backend === backend);
    return [
      backend,
      {
        passed: rows.filter((x) => x.status === "pass").length,
        failed: rows.filter((x) => x.status === "fail").length,
      },
    ];
  }),
);
writeResult("runtime-matrix.json", {
  checkedAt: new Date().toISOString(),
  profile: "portable experimental Web APIs in embedded engines; native globals in Node reference",
  summary,
  results,
});
console.log(JSON.stringify(summary, null, 2));
for (const row of results.filter((x) => x.status === "fail")) {
  console.log(
    `${row.backend}/${row.suite}/${row.id}: ${row.error?.split("\n").slice(0, 3).join(" ")}`,
  );
}
if (results.some((x) => x.status === "fail")) process.exitCode = 1;

function writeLog(backend: HostBackend, bundle: string, stderr: string): void {
  writeText(`logs/${backend}-${bundle}.stderr.log`, stderr);
}
