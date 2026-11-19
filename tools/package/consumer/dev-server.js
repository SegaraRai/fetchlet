// The server command of the `fetchlet dev` check: it starts after the build
// and exits, which ends `fetchlet dev` with its exit code.
import { readFileSync } from "node:fs";

console.log(`server started after the build: ${readFileSync("dev-build.txt", "utf8")}`);
