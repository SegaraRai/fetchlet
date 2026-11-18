// node:path with Node's POSIX semantics, after lib/path.js.

import {
  basename,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  matchesGlob,
  normalize,
  parse,
  path,
  posix,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from "./internal/path/posix.ts";

export {
  basename,
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
};

export default path;
