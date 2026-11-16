import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

/** Each case gets a fresh process and engine realm. The parent owns its deadline. */
export function runProcess(backend, bundle, timeoutMs, suite) {
  const native = backend === "node-reference";
  const executable = native
    ? process.execPath
    : resolve("target/debug/fetchlet-lab" + (process.platform === "win32" ? ".exe" : ""));
  const args = native ? ["tools/conformance/node-host.mjs", bundle, suite] : [backend, bundle];
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let reply;
    let stderr = "";
    let timedOut = false;
    let finished = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("FETCHLET_REPLY ")) {
        try {
          reply = JSON.parse(line.slice(15));
          finished = true;
          child.kill();
        } catch (error) {
          stderr += String(error);
        }
      } else stderr += line + "\n";
    });
    child.on("error", (error) => {
      stderr += String(error);
    });
    child.stdin.on("error", (error) => {
      stderr += String(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      if (timedOut) resolveResult({ status: "timeout", message: stderr });
      else if (
        suite === "test262" &&
        (reply?.ok === false || (!finished && code === 1 && stderr.startsWith("Error:")))
      ) {
        resolveResult({
          status: "complete",
          value: { tests: [{ name: "script", status: 1, message: reply?.error ?? stderr }] },
        });
      } else if ((!finished && code !== 0) || !reply?.ok)
        resolveResult({
          status: "runner-error",
          message: reply?.error ?? "process " + code + "/" + signal + ": " + stderr,
        });
      else resolveResult({ status: "complete", value: reply.value, stderr });
    });
    child.stdin.end(JSON.stringify({ export: "run", args: [] }) + "\n");
  });
}
