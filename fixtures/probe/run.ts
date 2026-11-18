// Runs the Web API probe in a reference runtime, outside fetchlet:
//
//   node fixtures/probe/run.ts
//   deno run --no-config --no-lock fixtures/probe/run.ts
import "./web-api.js";

interface ProbeReport {
  summary: { passed: number; failed: number };
}

const deno = (globalThis as { Deno?: { version: { deno: string }; exitCode: number } }).Deno;
const runtimeLabel = deno
  ? `Deno CLI ${deno.version.deno} (reference only; not embedded deno_core or rustyscript)`
  : `Node.js ${process.version} (reference only; not an embedded backend)`;
const probe = (
  globalThis as unknown as {
    fetchletProbe: (options: { runtimeLabel: string }) => Promise<ProbeReport>;
  }
).fetchletProbe;
const report = await probe({ runtimeLabel });
console.log(JSON.stringify(report, null, 2));
if (report.summary.failed) {
  if (deno) {
    deno.exitCode = 1;
  } else {
    process.exitCode = 1;
  }
}
