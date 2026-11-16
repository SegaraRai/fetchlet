import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

mkdirSync("results/logs", { recursive: true });
const results = [];
function host(backend, bundle) {
  const command =
    backend === "node-reference"
      ? process.execPath
      : resolve(
          process.platform === "win32"
            ? "target/debug/fetchlet-lab.exe"
            : "target/debug/fetchlet-lab",
        );
  const args = backend === "node-reference" ? ["tools/node-host.mjs", bundle] : [backend, bundle];
  const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let pending;
  let stderr = "";
  let ended = false;
  child.stderr.on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("FETCHLET_REPLY ")) {
      stderr += "[stdout] " + line + "\n";
      return;
    }
    if (pending) {
      const p = pending;
      pending = null;
      try {
        p.resolve(JSON.parse(line.slice(15)));
      } catch (error) {
        p.reject(error);
      }
    }
  });
  child.on("error", (error) => {
    ended = true;
    pending?.reject(error);
    pending = null;
  });
  child.on("exit", (code, signal) => {
    ended = true;
    pending?.reject(new Error(`Host exited ${code}/${signal}: ${stderr.slice(-3000)}`));
    pending = null;
  });
  return {
    async raw(name, args = []) {
      if (ended) throw new Error("Host is no longer running: " + stderr.slice(-1000));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Host deadline exceeded"));
        }, 15000);
        pending = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        child.stdin.write(JSON.stringify({ export: name, args }) + "\n");
      });
    },
    async call(name, args = []) {
      const result = await this.raw(name, args);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    close() {
      child.stdin.end();
      if (!ended) child.kill();
      writeFileSync(
        `results/logs/${backend}-${bundle.includes("sveltekit") ? "sveltekit" : "functions"}.stderr.log`,
        stderr,
      );
    },
  };
}
const request = (path, init = {}) => ({
  url: "https://fetchlet.invalid" + path,
  method: "GET",
  headers: [],
  body: null,
  ...init,
});
const text = (response) => new TextDecoder().decode(new Uint8Array(response.body));
async function check(backend, suite, id, operation) {
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
      error: String(error.stack ?? error),
    });
  }
}

for (const backend of ["node-reference", "quickjs", "boa", "v8"]) {
  const app = host(backend, "artifacts/functions-hono.js");
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
    const res = await app.call("handle", [request("/hello/%3CAda%3E")]);
    assert.equal(res.status, 200);
    assert.match(text(res), /Hello, &lt;Ada&gt;/);
    assert.ok(res.headers.some(([k, v]) => k === "x-fetchlet" && v === "hono"));
  });
  await check(backend, "hono", "json-post", async () => {
    const res = await app.call("handle", [
      request("/echo", {
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: [...new TextEncoder().encode('{"name":"日本語"}')],
      }),
    ]);
    assert.equal(res.status, 201);
    assert.deepEqual(JSON.parse(text(res)), { name: "日本語" });
  });
  await check(backend, "hono", "set-cookie", async () => {
    const res = await app.call("handle", [request("/cookies")]);
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
    writeFileSync(`results/web-api-${backend}.json`, JSON.stringify(report, null, 2) + "\n");
    // A partial profile is recorded explicitly rather than reported as fully passing.
    assert.equal(
      report.summary.failed,
      0,
      JSON.stringify(
        report.checks.filter((x) => x.status === "fail").map((x) => ({ id: x.id, error: x.error })),
      ),
    );
    return report.summary;
  });
  app.close();
  const kit = host(backend, "artifacts/sveltekit.js");
  await check(backend, "sveltekit", "ssr-page", async () => {
    const res = await kit.call("handle", [request("/?name=Rust")]);
    assert.equal(res.status, 200, JSON.stringify(res.diagnostics));
    assert.match(text(res), /Hello, Rust/);
    assert.match(text(res), /SSR from Rust/);
  });
  await check(backend, "sveltekit", "escaped-query", async () => {
    const res = await kit.call("handle", [request("/?name=%3Cscript%3E")]);
    assert.equal(res.status, 200, JSON.stringify(res.diagnostics));
    assert.match(text(res), /&lt;script(?:&gt;|>)/);
  });
  await check(backend, "sveltekit", "json-endpoint", async () => {
    const res = await kit.call("handle", [
      request("/api/echo", {
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: [...new TextEncoder().encode('{"ok":true}')],
      }),
    ]);
    assert.equal(res.status, 201);
    assert.deepEqual(JSON.parse(text(res)), { ok: true });
  });
  await check(backend, "sveltekit", "form-action", async () => {
    const res = await kit.call("handle", [
      request("/", {
        method: "POST",
        headers: [
          ["content-type", "application/x-www-form-urlencoded"],
          ["origin", "https://fetchlet.invalid"],
          ["accept", "application/json"],
          ["x-sveltekit-action", "true"],
        ],
        body: [...new TextEncoder().encode("name=Alice")],
      }),
    ]);
    assert.equal(res.status, 200);
    const action = JSON.parse(text(res));
    assert.equal(action.type, "success");
    assert.match(action.data, /Alice/);
  });
  kit.close();
}
const summary = Object.fromEntries(
  [...new Set(results.map((x) => x.backend))].map((backend) => {
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
writeFileSync(
  "results/runtime-matrix.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      profile:
        "portable experimental Web APIs in embedded engines; native globals in Node reference",
      summary,
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
for (const row of results.filter((x) => x.status === "fail"))
  console.log(
    `${row.backend}/${row.suite}/${row.id}: ${row.error.split("\n").slice(0, 3).join(" ")}`,
  );
if (results.some((x) => x.status === "fail")) process.exitCode = 1;
