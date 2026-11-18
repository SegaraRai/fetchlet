// node:path with Node's POSIX semantics, after lib/path.js.

export {
  basename,
  path as default,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  matchesGlob,
  normalize,
  parse,
  posix,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from "./internal/path/posix.ts";
