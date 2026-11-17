// Copies the sample notes to a working directory once, so the demo can edit
// them freely. Delete the directory to start over.
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const [source, target] = process.argv.slice(2).map((path) => resolve(path));
if (existsSync(target)) {
  console.log(`Using the demo notes in ${target}`);
} else {
  cpSync(source, target, { recursive: true });
  console.log(`Copied the sample notes to ${target}`);
}
