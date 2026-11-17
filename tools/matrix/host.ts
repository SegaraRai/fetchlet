// Checks host services through each backend: outbound fetch policy, Rust
// transports, bindings, abort and retirement. Records results/host-matrix.json:
// `vp run test:host`.
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { backends, runLab, type Backend, type Reply } from "@fetchlet-internal/tools-workspace/lab";
import { root } from "@fetchlet-internal/tools-workspace/paths";
import {
  describe,
  environment,
  summarize,
  writeResult,
  writeText,
} from "@fetchlet-internal/tools-workspace/results";

interface Row {
  backend: Backend;
  name: string;
  status: "pass" | "fail";
  error?: string;
}

const results: Row[] = [];
const bundle = resolve(root, "artifacts/functions-hono.js");

/** Runs one host session. `mock` connects the Rust mock transport; otherwise fetch is denied. */
function runSession(backend: Backend, mock: boolean, commands: unknown[]): Reply[] {
  const args = [backend, bundle, ...(mock ? ["--mock"] : [])];
  const session = runLab(args, commands);
  writeText(
    `logs/${backend}-host-${mock ? "mock" : "denied"}.log`,
    session.stdout + "\n" + session.stderr,
  );
  assert.equal(session.status, 0, session.stderr);
  assert.equal(session.replies.length, commands.length, "Missing host replies");
  return session.replies;
}

function check(backend: Backend, name: string, verify: () => void): void {
  try {
    verify();
    results.push({ backend, name, status: "pass" });
  } catch (error) {
    results.push({ backend, name, status: "fail", error: describe(error) });
  }
}

function command(name: string, ...args: unknown[]) {
  return {
    export: name,
    args,
  };
}

/** The value of a successful reply. */
function value(reply: Reply | undefined): any {
  assert.ok(reply?.ok, reply && !reply.ok ? reply.error : "missing reply");
  return reply.value;
}

for (const backend of backends) {
  try {
    const denied = runSession(backend, false, [
      command("fetchThroughHost", "https://api.fetchlet.test/data"),
      command("add", 20, 22),
    ]);
    check(backend, "outbound-denied-by-default", () => {
      assert.deepEqual(denied[0], {
        ok: true,
        value: { error: "PERMISSION_DENIED" },
      });
      assert.deepEqual(denied[1], { ok: true, value: 42 });
    });

    const delayed = runSession(backend, true, [
      command("fetchThroughHost", "https://api.fetchlet.test/delayed"),
    ]);
    check(backend, "transport-completion-wakes-engine", () => {
      const response = value(delayed[0]);
      assert.equal(response.status, 200);
      assert.equal(response.data.path, "/delayed");
    });

    const streamed = runSession(backend, false, [
      {
        fetch: {
          method: "POST",
          url: "https://app.fetchlet.test/echo",
          chunks: ['{"name":', '"こんにちは",', '"items":[1,2]}'],
        },
      },
      command("add", 20, 22),
    ]);
    check(backend, "streamed-request-body-through-web-runtime", () => {
      const response = value(streamed[0]);
      assert.equal(response.status, 201);
      assert.deepEqual(JSON.parse(response.body), {
        name: "こんにちは",
        items: [1, 2],
      });
      assert.deepEqual(streamed[1], { ok: true, value: 42 });
    });

    const replies = runSession(backend, true, [
      command("hostEnvironment"),
      command("fetchThroughHost", "https://api.fetchlet.test/data", [0, 128, 255]),
      command("fetchThroughHost", "https://api.fetchlet.test/redirect"),
      command("fetchThroughHost", "https://api.fetchlet.test/redirect-denied"),
      command("fetchThroughHost", "https://api.fetchlet.test/rewrite-denied"),
      command("fetchFromService", "https://api.fetchlet.test/service"),
      command("abortHostFetch", "https://api.fetchlet.test/slow"),
      command("add", 20, 22),
      command("abortRequestBody", "https://api.fetchlet.test/data"),
      command("add", 20, 22),
      command("leaveFetchUnfinished", "https://api.fetchlet.test/slow"),
      command("add", 20, 22),
    ]);

    check(backend, "explicit-frozen-bindings", () => {
      const environment = value(replies[0]);
      assert.equal(environment.mode, "mock");
      assert.equal(environment.frozen, true);
      assert.deepEqual(environment.names.sort(), ["API", "MODE"]);
    });

    check(backend, "binary-post-credentials-and-cookies", () => {
      const response = value(replies[1]);
      assert.equal(response.status, 200);
      assert.deepEqual(response.cookies, ["first=1", "second=2"]);
      assert.deepEqual(response.data, {
        method: "POST",
        path: "/data",
        body: [0, 128, 255],
        authenticated: true,
      });
    });

    check(backend, "allowed-redirect", () => {
      assert.equal(value(replies[2]).data.path, "/data");
    });

    check(backend, "denied-redirect", () => {
      assert.deepEqual(replies[3], {
        ok: true,
        value: { error: "PERMISSION_DENIED" },
      });
    });

    check(backend, "denied-rewritten-destination", () => {
      assert.deepEqual(replies[4], {
        ok: true,
        value: { error: "PERMISSION_DENIED" },
      });
    });

    check(backend, "named-rust-service", () => {
      const response = value(replies[5]);
      assert.equal(response.path, "/service");
      assert.equal(response.authenticated, true);
    });

    check(backend, "abort-and-reuse", () => {
      assert.deepEqual(replies[6], {
        ok: true,
        value: { aborted: true, message: "cancelled" },
      });
      assert.deepEqual(replies[7], { ok: true, value: 42 });
    });

    check(backend, "unfinished-host-work-retires-instance", () => {
      assert.deepEqual(replies[10], { ok: true, value: "started" });
      const retired = replies[11];
      assert.ok(retired && !retired.ok, "the retired instance must refuse the call");
      assert.match(retired.error, /cannot be reused/);
    });

    check(backend, "abort-while-reading-request-body", () => {
      assert.deepEqual(replies[8], {
        ok: true,
        value: { aborted: true, message: "body cancelled" },
      });
      assert.deepEqual(replies[9], { ok: true, value: 42 });
    });
  } catch (error) {
    results.push({
      backend,
      name: "session",
      status: "fail",
      error: describe(error),
    });
  }
}

const summary = summarize(results);
writeResult("host-matrix.json", {
  environment: environment(),
  summary,
  results,
});
console.log(JSON.stringify(summary, null, 2));
for (const result of results.filter((result) => result.status === "fail")) {
  console.error(`${result.backend}/${result.name}: ${result.error}`);
}
if (summary.failed > 0) {
  process.exitCode = 1;
}
