// node:fs for the vinext server: the artifact has no files, so every file is
// missing and vinext keeps its caches in memory.

const missing = (path: string): Error =>
  Object.assign(new Error("ENOENT: no such file or directory, " + path), {
    code: "ENOENT",
  });

export const existsSync = (): boolean => false;

export function readFileSync(path: string): never {
  throw missing(path);
}

export default {
  existsSync,
  readFileSync,
};
