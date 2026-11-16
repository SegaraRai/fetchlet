import { readFileSync } from "node:fs";
import vm from "node:vm";

function reply(value) {
  console.log("FETCHLET_REPLY " + JSON.stringify(value));
}
const unhandled = [];
process.on("unhandledRejection", (error) => unhandled.push(String(error)));
try {
  const script = new vm.Script(readFileSync(process.argv[2], "utf8"), {
    filename: process.argv[2],
  });
  script.runInThisContext();
  // Node's AbortSignal.timeout timers are unref'd. Keep the reference process alive until the
  // harness completes, as the fetchlet hosts drive timers until the invocation settles; the
  // parent process timeout still bounds the run.
  const keepAlive = setInterval(() => {}, 1000);
  const value = await globalThis.fetchletExports.run().finally(() => clearInterval(keepAlive));
  if (process.argv[3] === "wpt") {
    await new Promise((resolve) => setImmediate(resolve));
    if (unhandled.length) value.harness = { status: 1, message: unhandled.join("\n") };
  }
  reply({ ok: true, value });
} catch (error) {
  reply({ ok: false, error: String(error.stack ?? error) });
}
