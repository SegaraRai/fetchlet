// node:fs for the vinext server: the artifact has no files, so every file is
// missing and vinext keeps its caches in memory.
const missing = (path) =>
  Object.assign(new Error("ENOENT: no such file or directory, " + path), { code: "ENOENT" });

export const existsSync = () => false;

export function readFileSync(path) {
  throw missing(path);
}

export default { existsSync, readFileSync };
