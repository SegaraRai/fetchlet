// The build command of the `fetchlet dev` check: records that it ran.
import { writeFileSync } from "node:fs";

writeFileSync("dev-build.txt", "built");
