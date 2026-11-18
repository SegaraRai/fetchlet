// node:util: promisify, callbackify, inherits, deprecate, format, inspect,
// isDeepStrictEqual, types and the smaller helpers libraries reach for.

import { isDeepStrictEqual } from "./internal/util/comparisons.ts";
import {
  callbackify,
  debug,
  debuglog,
  deprecate,
  inherits,
  isArray,
  promisify,
} from "./internal/util/functions.ts";
import { format, formatWithOptions, inspect } from "./internal/util/inspect.ts";
import {
  stripVTControlCharacters,
  TextDecoder,
  TextEncoder,
  toUSVString,
} from "./internal/util/text.ts";
import { types } from "./internal/util/types.ts";

export {
  callbackify,
  debug,
  debuglog,
  deprecate,
  format,
  formatWithOptions,
  inherits,
  inspect,
  isArray,
  isDeepStrictEqual,
  promisify,
  stripVTControlCharacters,
  TextDecoder,
  TextEncoder,
  toUSVString,
  types,
};

export default {
  types,
  promisify,
  callbackify,
  inherits,
  deprecate,
  inspect,
  format,
  formatWithOptions,
  isDeepStrictEqual,
  debuglog,
  debug,
  stripVTControlCharacters,
  toUSVString,
  isArray,
  TextEncoder,
  TextDecoder,
};
