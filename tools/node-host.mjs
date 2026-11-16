import { readFileSync } from "node:fs";
import vm from "node:vm";
import readline from "node:readline";
vm.runInThisContext(readFileSync(process.argv[2], "utf8"), { filename: process.argv[2] });
for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const { export: name, args = [] } = JSON.parse(line);
    const value = await globalThis.fetchletExports[name](...args);
    console.log("FETCHLET_REPLY " + JSON.stringify({ ok: true, value }));
  } catch (error) {
    console.log(
      "FETCHLET_REPLY " + JSON.stringify({ ok: false, error: String(error.stack ?? error) }),
    );
  }
}
