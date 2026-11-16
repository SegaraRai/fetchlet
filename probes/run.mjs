import "./web-api.js";

const isDeno = typeof globalThis.Deno?.version?.deno === "string";
const runtimeLabel = isDeno
  ? `Deno CLI ${Deno.version.deno} (reference only; not embedded deno_core or rustyscript)`
  : `Node.js ${process.version} (reference only; not an embedded backend)`;
const report = await globalThis.fetchletProbe({ runtimeLabel });
console.log(JSON.stringify(report, null, 2));
if (report.summary.failed) {
  if (isDeno) Deno.exitCode = 1;
  else process.exitCode = 1;
}
