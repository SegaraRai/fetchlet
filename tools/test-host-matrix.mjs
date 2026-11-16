import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const results = [];
const replyPrefix = "FETCHLET_REPLY ";
const executable = resolve(
  process.platform === "win32" ? "target/debug/fetchlet-lab.exe" : "target/debug/fetchlet-lab",
);

mkdirSync("results/logs", { recursive: true });

function runSession(backend, mock, commands) {
  const argumentsList = [backend, "artifacts/functions-hono.js"];
  if (mock) {
    argumentsList.push("--mock");
  }

  const execution = spawnSync(executable, argumentsList, {
    input: commands.map((command) => JSON.stringify(command)).join("\n") + "\n",
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  writeFileSync(
    `results/logs/${backend}-host-${mock ? "mock" : "denied"}.log`,
    execution.stdout + "\n" + execution.stderr,
  );

  if (execution.error) {
    throw execution.error;
  }
  assert.equal(execution.status, 0, execution.stderr);

  const replies = execution.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(replyPrefix))
    .map((line) => JSON.parse(line.slice(replyPrefix.length)));

  assert.equal(replies.length, commands.length, "Missing host replies");
  return replies;
}

function check(backend, name, verify) {
  try {
    verify();
    results.push({ backend, name, status: "pass" });
  } catch (error) {
    results.push({ backend, name, status: "fail", error: String(error.stack ?? error) });
  }
}

function command(name, ...args) {
  return { export: name, args };
}

for (const backend of ["quickjs", "boa", "v8"]) {
  try {
    const denied = runSession(backend, false, [
      command("fetchThroughHost", "https://api.fetchlet.test/data"),
      command("add", 20, 22),
    ]);

    check(backend, "outbound-denied-by-default", () => {
      assert.deepEqual(denied[0], { ok: true, value: { error: "PERMISSION_DENIED" } });
      assert.deepEqual(denied[1], { ok: true, value: 42 });
    });

    const delayed = runSession(backend, true, [
      command("fetchThroughHost", "https://api.fetchlet.test/delayed"),
    ]);
    check(backend, "transport-completion-wakes-engine", () => {
      assert.equal(delayed[0].ok, true);
      assert.equal(delayed[0].value.status, 200);
      assert.equal(delayed[0].value.data.path, "/delayed");
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
      assert.equal(streamed[0].ok, true, streamed[0].error);
      assert.equal(streamed[0].value.status, 201);
      assert.deepEqual(JSON.parse(streamed[0].value.body), { name: "こんにちは", items: [1, 2] });
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
      assert.equal(replies[0].ok, true);
      assert.equal(replies[0].value.mode, "mock");
      assert.equal(replies[0].value.frozen, true);
      assert.deepEqual(replies[0].value.names.sort(), ["API", "MODE"]);
    });

    check(backend, "binary-post-credentials-and-cookies", () => {
      assert.equal(replies[1].ok, true);
      assert.equal(replies[1].value.status, 200);
      assert.deepEqual(replies[1].value.cookies, ["first=1", "second=2"]);
      assert.deepEqual(replies[1].value.data, {
        method: "POST",
        path: "/data",
        body: [0, 128, 255],
        authenticated: true,
      });
    });

    check(backend, "allowed-redirect", () => {
      assert.equal(replies[2].ok, true);
      assert.equal(replies[2].value.data.path, "/data");
    });

    check(backend, "denied-redirect", () => {
      assert.deepEqual(replies[3], { ok: true, value: { error: "PERMISSION_DENIED" } });
    });

    check(backend, "denied-rewritten-destination", () => {
      assert.deepEqual(replies[4], { ok: true, value: { error: "PERMISSION_DENIED" } });
    });

    check(backend, "named-rust-service", () => {
      assert.equal(replies[5].ok, true);
      assert.equal(replies[5].value.path, "/service");
      assert.equal(replies[5].value.authenticated, true);
    });

    check(backend, "abort-and-reuse", () => {
      assert.deepEqual(replies[6], { ok: true, value: { aborted: true, message: "cancelled" } });
      assert.deepEqual(replies[7], { ok: true, value: 42 });
    });

    check(backend, "unfinished-host-work-retires-instance", () => {
      assert.deepEqual(replies[10], { ok: true, value: "started" });
      assert.equal(replies[11].ok, false);
      assert.match(replies[11].error, /cannot be reused/);
    });

    check(backend, "abort-while-reading-request-body", () => {
      assert.deepEqual(replies[8], {
        ok: true,
        value: { aborted: true, message: "body cancelled" },
      });
      assert.deepEqual(replies[9], { ok: true, value: 42 });
    });
  } catch (error) {
    results.push({ backend, name: "session", status: "fail", error: String(error.stack ?? error) });
  }
}

const summary = {
  passed: results.filter((result) => result.status === "pass").length,
  failed: results.filter((result) => result.status === "fail").length,
};

writeFileSync(
  "results/host-matrix.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      summary,
      results,
    },
    null,
    2,
  ) + "\n",
);

console.log(JSON.stringify(summary, null, 2));
for (const result of results.filter((result) => result.status === "fail")) {
  console.error(`${result.backend}/${result.name}: ${result.error}`);
}

if (summary.failed > 0) {
  process.exitCode = 1;
}
