import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
mkdirSync("artifacts/aot", { recursive: true });
mkdirSync("results/logs", { recursive: true });
const bundledOnly = process.argv.includes("--bundled");
const results = bundledOnly
  ? JSON.parse(readFileSync("results/aot-matrix.json", "utf8")).results.filter(
      (x) => x.inputMode !== "bundled-es2019",
    )
  : [];
function run(command, args, timeout = 180000) {
  return new Promise((done) => {
    const started = performance.now();
    const perryDir = resolve(".cache/tools/perry");
    const child = spawn(command, args, {
      windowsHide: true,
      env: {
        ...process.env,
        PATH: resolve(".cache/tools/zig-x86_64-windows-0.15.2") + ";" + process.env.PATH,
        ZIG_GLOBAL_CACHE_DIR: resolve(".cache/zig-global"),
        PERRY_NO_AUTO_FETCH: "1",
        PERRY_RUNTIME_DIR: perryDir,
        PERRY_STDLIB_DIR: perryDir,
      },
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    child.stdout.on("data", (s) => (stdout += s));
    child.stderr.on("data", (s) => (stderr += s));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({
        code: null,
        error: String(error),
        stdout,
        stderr,
        durationMs: performance.now() - started,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, timedOut, stdout, stderr, durationMs: performance.now() - started });
    });
  });
}
await Promise.all(
  ["perry", "scriptc"].map(async (backend) => {
    const command = resolve(
      backend === "perry" ? ".cache/tools/perry/perry.exe" : ".cache/tools/scriptc/bin/scriptc.exe",
    );
    for (const variant of bundledOnly
      ? ["hono-bundled", "sveltekit-bundled"]
      : ["plain", "hono", "sveltekit", "hono-bundled", "sveltekit-bundled"]) {
      const fixture = variant.replace("-bundled", "");
      const bundled = variant.endsWith("-bundled");
      const output = resolve(`artifacts/aot/${backend}-${variant}.exe`);
      const input = resolve(bundled ? `artifacts/aot-${fixture}.js` : `fixtures/aot/${fixture}.ts`);
      const args =
        backend === "perry" ? ["compile", input, "-o", output] : ["build", input, "-o", output];
      const build = await run(command, args);
      writeFileSync(
        `results/logs/${backend}-${variant}-build.log`,
        build.stdout + "\n" + build.stderr,
      );
      const row = {
        backend,
        suite: fixture,
        inputMode: bundled ? "bundled-es2019" : "module-source",
        inputSha256: createHash("sha256").update(readFileSync(input)).digest("hex"),
        mode: "native-executable",
        compiler: backend === "perry" ? "0.5.1665" : "0.4.14",
        build: { code: build.code, timedOut: build.timedOut, durationMs: build.durationMs },
        status: "fail",
      };
      if (build.code === 0) {
        const execution = await run(output, [], 30000);
        row.execution = execution;
        try {
          if (execution.code !== 0)
            throw new Error(
              `Executable exited ${execution.code}: ${execution.stderr.slice(-2000)}`,
            );
          const lines = execution.stdout.trim().split(/\r?\n/);
          const value = JSON.parse(lines.at(-1));
          if (fixture === "plain") {
            if (value.add !== 42 || value.transform.sum !== 6 || value.async.value !== "ok")
              throw new Error("Incorrect function result");
          } else {
            const html = new TextDecoder().decode(new Uint8Array(value.body));
            if (value.status !== 200 || !html.includes("Hello, Rust"))
              throw new Error("Incorrect HTTP result: " + html.slice(0, 600));
          }
          row.status = "pass";
        } catch (error) {
          row.error = String(error);
        }
      } else
        row.error = (
          build.stderr ||
          build.stdout ||
          build.error ||
          `Compiler exited ${build.code}; timedOut=${build.timedOut}`
        ).slice(-5000);
      results.push(row);
      console.log(`${backend}/${variant}: ${row.status}`);
      writeFileSync(
        "results/aot-matrix.json",
        JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + "\n",
      );
    }
  }),
);
if (results.some((x) => x.status === "fail")) process.exitCode = 1;
