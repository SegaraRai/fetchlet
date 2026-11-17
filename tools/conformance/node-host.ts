import { readFileSync } from "node:fs";
import vm from "node:vm";

// The Node reference host for one conformance case: evaluates the bundle as
// a global script, runs its `run` export and replies once.
//
//   node tools/conformance/node-host.ts <bundle.js> <suite>
function reply(value: unknown): void {
  console.log("FETCHLET_REPLY " + JSON.stringify(value));
}
const unhandled: string[] = [];
process.on("unhandledRejection", (error) => unhandled.push(String(error)));
try {
  const bundle = process.argv[2]!;
  const script = new vm.Script(readFileSync(bundle, "utf8"), { filename: bundle });
  script.runInThisContext();
  // Node's AbortSignal.timeout timers are unref'd. Keep the reference process alive until the
  // harness completes, as the fetchlet hosts drive timers until the invocation settles; the
  // parent process timeout still bounds the run.
  const keepAlive = setInterval(() => {}, 1000);
  const exports = (globalThis as any).fetchletExports as { run(): Promise<any> };
  const value = await exports.run().finally(() => clearInterval(keepAlive));
  if (process.argv[3] === "wpt") {
    await new Promise((resolve) => setImmediate(resolve));
    if (unhandled.length) value.harness = { status: 1, message: unhandled.join("\n") };
  }
  reply({ ok: true, value });
} catch (error) {
  reply({ ok: false, error: String((error as Error)?.stack ?? error) });
}
